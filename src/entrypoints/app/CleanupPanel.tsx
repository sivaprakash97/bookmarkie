import { liveQuery } from 'dexie';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  candidatesFor,
  findDuplicates,
  restoreFromTrash,
  TRASH_DAYS,
  type Candidate,
  type DuplicateGroup,
} from '@/core/cleanup';
import { db, getSetting, setSetting } from '@/core/db';
import { ensureVectors } from '@/core/embed';
import { needsCheck, runLinkCheck, type LinkCheckProgress } from '@/core/linkCheck';
import { cutoffFor, DEFAULT_STRICTNESS, DEFAULT_TOPICS, scoreTopics, type TopicScore } from '@/core/topics';
import type { Item, TrashEntry } from '@/core/types';
import { absoluteDate, displayUrl, relativeTime } from './format';
import { downloadBackup } from './ReviewScreen';
import { ModelMissingError, WorkerEmbedder } from './workerEmbedder';

interface Props {
  items: Item[];
  onReview: (candidates: Candidate[]) => void;
}

const ALL_URLS = { origins: ['<all_urls>'] };

/** Only bookmarks Bookmarkie can delete: live Chrome or Reading List saves. */
function deletable(items: Item[]): Item[] {
  return items.filter((i) => !i.removed && i.sources.some((s) => s === 'chrome' || s === 'readinglist'));
}

export function CleanupPanel({ items, onReview }: Props) {
  const pool = useMemo(() => deletable(items), [items]);
  return (
    <main className="cleanup">
      <h1>Clean up</h1>
      <p className="lead">
        Find bookmarks you don't need any more. You'll see the full list and can untick anything before it's
        deleted, and deleted bookmarks can be restored for {TRASH_DAYS} days.
      </p>
      <BackupCard />
      <TopicsCard pool={pool} onReview={onReview} />
      <DeadLinksCard pool={pool} onReview={onReview} />
      <DuplicatesCard items={items} onReview={onReview} />
      <TrashCard />
    </main>
  );
}

function BackupCard() {
  const [last, setLast] = useState<number | null>(null);
  useEffect(() => {
    const sub = liveQuery(() => getSetting<number | null>('lastBackupAt', null)).subscribe({ next: setLast });
    return () => sub.unsubscribe();
  }, []);
  return (
    <section className="card">
      <h2>Backup</h2>
      <p>
        Download all your Chrome bookmarks as a file you can import into any browser.
        {last ? ` Last backup ${relativeTime(last)}.` : ' Recommended before your first clean-up.'}
      </p>
      <button onClick={() => void downloadBackup()}>Download backup</button>
    </section>
  );
}

let sharedEmbedder: WorkerEmbedder | null = null;

function TopicsCard({ pool, onReview }: { pool: Item[]; onReview: Props['onReview'] }) {
  const [topicsText, setTopicsText] = useState(DEFAULT_TOPICS.join(', '));
  const [strictness, setStrictness] = useState(DEFAULT_STRICTNESS);
  const [phase, setPhase] = useState<'idle' | 'running' | 'done' | 'missing' | 'error'>('idle');
  const [progress, setProgress] = useState<[number, number]>([0, 0]);
  const [scores, setScores] = useState<TopicScore[]>([]);
  const [error, setError] = useState('');
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    void getSetting<string[]>('keepTopics', DEFAULT_TOPICS).then((t) => setTopicsText(t.join(', ')));
    void getSetting<number>('topicStrictness', DEFAULT_STRICTNESS).then(setStrictness);
    return () => abort.current?.abort();
  }, []);

  const topics = topicsText.split(',').map((t) => t.trim()).filter(Boolean);

  const run = async () => {
    abort.current?.abort();
    const ctrl = (abort.current = new AbortController());
    await setSetting('keepTopics', topics);
    setPhase('running');
    setProgress([0, 0]);
    try {
      sharedEmbedder ??= new WorkerEmbedder();
      const vectors = await ensureVectors(pool, sharedEmbedder, {
        signal: ctrl.signal,
        onProgress: (done, total) => setProgress([done, total]),
      });
      if (ctrl.signal.aborted) return;
      setScores(await scoreTopics(pool, vectors, topics, sharedEmbedder));
      setPhase('done');
    } catch (err) {
      if (err instanceof ModelMissingError) setPhase('missing');
      else {
        setError(err instanceof Error ? err.message : String(err));
        setPhase('error');
      }
    }
  };

  // Bookmarks deleted since the last run drop out without re-running the model.
  const poolIds = useMemo(() => new Set(pool.map((i) => i.id)), [pool]);
  const current = useMemo(() => scores.filter((s) => poolIds.has(s.item.id)), [scores, poolIds]);
  const cutoff = cutoffFor(strictness);
  const unrelated = current.filter((s) => s.score < cutoff);
  const keptByRule = current.filter((s) => s.rule).length;

  const review = async () => {
    const byId = new Map(unrelated.map((s) => [s.item.id!, s]));
    onReview(
      await candidatesFor([...byId.keys()], 'topic', (id) => {
        const pct = Math.round(Math.max(0, byId.get(id)!.score) * 100);
        return `${pct}% match to ${topics.slice(0, 3).join(', ')}${topics.length > 3 ? '…' : ''}`;
      }),
    );
  };

  return (
    <section className="card">
      <h2>Not about my topics</h2>
      <p>
        On-device AI compares each bookmark's title and address with the topics you want to keep. It runs on your
        computer for free, and nothing is sent anywhere.
      </p>
      <div className="row-form">
        <label className="grow">
          Keep bookmarks about
          <input type="text" value={topicsText} onChange={(e) => setTopicsText(e.target.value)}
            placeholder="design, typography, branding" />
        </label>
        <button className="primary" disabled={!topics.length || phase === 'running'} onClick={() => void run()}>
          {phase === 'done' ? 'Run again' : 'Find unrelated bookmarks'}
        </button>
      </div>

      {phase === 'running' && (
        <div className="progress" aria-live="polite">
          {progress[1] ? `Reading your bookmarks… ${progress[0].toLocaleString()} of ${progress[1].toLocaleString()}` : 'Starting the AI model…'}
          <progress value={progress[0]} max={progress[1] || 1} />
        </div>
      )}
      {phase === 'missing' && (
        <p className="warn">
          The AI model isn't installed yet. Connect to the internet and run <code>npm run build</code> in the
          Bookmarkie folder, then reload the extension.
        </p>
      )}
      {phase === 'error' && <p className="warn">Something went wrong: {error}</p>}

      {phase === 'done' && (
        <>
          <label className="slider">
            <span>Strictness</span>
            <input type="range" min={0} max={100} value={strictness}
              onChange={(e) => setStrictness(Number(e.target.value))}
              onPointerUp={() => void setSetting('topicStrictness', strictness)}
              onKeyUp={() => void setSetting('topicStrictness', strictness)} />
            <span className="hint-text">{strictness < 34 ? 'Only clearly unrelated' : strictness < 67 ? 'Balanced' : 'Anything not clearly on-topic'}</span>
          </label>
          <p>
            <strong>{unrelated.length.toLocaleString()}</strong> of {current.length.toLocaleString()} bookmarks look
            unrelated to {topics.join(', ')}.
            {keptByRule > 0 && ` ${keptByRule.toLocaleString()} are kept automatically because they're on design sites or in matching folders.`}
          </p>
          <Preview items={unrelated.slice(0, 6).map((s) => s.item)} />
          <p className="note">It only sees titles and addresses, so it can be wrong. You'll check every one next.</p>
          <button className="primary" disabled={!unrelated.length} onClick={() => void review()}>
            Review {unrelated.length.toLocaleString()} bookmark{unrelated.length === 1 ? '' : 's'} →
          </button>
        </>
      )}
    </section>
  );
}

function DeadLinksCard({ pool, onReview }: { pool: Item[]; onReview: Props['onReview'] }) {
  const [progress, setProgress] = useState<LinkCheckProgress | null>(null);
  const [running, setRunning] = useState(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const web = pool.filter((i) => /^https?:/i.test(i.url));
  const dead = web.filter((i) => i.linkCheck?.status === 'dead');
  const unsure = web.filter((i) => i.linkCheck?.status === 'unsure');
  const unchecked = web.filter((i) => needsCheck(i)).length;

  const start = async () => {
    // Visiting other sites needs permission; Chrome asks once.
    if (!(await browser.permissions.contains(ALL_URLS)) && !(await browser.permissions.request(ALL_URLS))) return;
    const ctrl = (abort.current = new AbortController());
    setRunning(true);
    const result = await runLinkCheck(web, { signal: ctrl.signal, onProgress: setProgress });
    setProgress(result);
    setRunning(false);
  };

  const describe = (i: Item) =>
    i.linkCheck?.code ? `The site answered ${i.linkCheck.code}` : i.linkCheck?.status === 'dead' ? "The site can't be reached" : 'No answer in time';

  return (
    <section className="card">
      <h2>Dead links</h2>
      <p>
        Checks which bookmarked pages no longer exist. Pages that block checks are listed separately and never
        ticked for deletion. Sites that now show a "domain for sale" page look alive, so a few dead ones may slip through.
      </p>
      {running && progress ? (
        <div className="progress" aria-live="polite">
          Checked {progress.done.toLocaleString()} of {progress.total.toLocaleString()} · {progress.dead} dead so far
          <progress value={progress.done} max={progress.total || 1} />
          <button onClick={() => abort.current?.abort()}>Stop</button>
        </div>
      ) : (
        <button className="primary" disabled={running} onClick={() => void start()}>
          {unchecked === web.length ? `Check ${web.length.toLocaleString()} links` : unchecked ? `Check ${unchecked.toLocaleString()} more links` : 'All links checked'}
        </button>
      )}
      {progress?.looksOffline && (
        <p className="warn">Almost no sites could be reached. Are you offline? Nothing was marked as dead.</p>
      )}
      {(dead.length > 0 || unsure.length > 0) && (
        <div className="result-buttons">
          <button disabled={!dead.length}
            onClick={async () => onReview(await candidatesFor(dead.map((i) => i.id!), 'dead', (id) => describe(dead.find((i) => i.id === id)!)))}>
            Review {dead.length.toLocaleString()} dead link{dead.length === 1 ? '' : 's'} →
          </button>
          <button disabled={!unsure.length}
            onClick={async () => onReview(await candidatesFor(unsure.map((i) => i.id!), 'unsure', (id) => describe(unsure.find((i) => i.id === id)!)))}>
            Review {unsure.length.toLocaleString()} that couldn't be checked →
          </button>
        </div>
      )}
    </section>
  );
}

function DuplicatesCard({ items, onReview }: { items: Item[]; onReview: Props['onReview'] }) {
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  useEffect(() => {
    void findDuplicates().then(setGroups);
  }, [items]);
  const extras = groups?.reduce((n, g) => n + g.extras.length, 0) ?? 0;

  const review = () => {
    onReview(
      (groups ?? []).flatMap((g) =>
        g.extras.map((s) => ({
          itemId: g.item.id!,
          saveIds: [s.id!],
          kind: 'duplicate' as const,
          reason: `Keeping the copy in ${g.keep.folderPath ?? 'your bookmarks'} (saved ${absoluteDate(g.keep.savedAt)})`,
          preselected: true,
        })),
      ),
    );
  };

  return (
    <section className="card">
      <h2>Duplicates</h2>
      {!groups ? <p>Looking…</p> : groups.length === 0 ? <p>No link is bookmarked twice.</p> : (
        <>
          <p>
            <strong>{groups.length.toLocaleString()}</strong> link{groups.length === 1 ? ' is' : 's are'} bookmarked
            more than once ({extras.toLocaleString()} extra cop{extras === 1 ? 'y' : 'ies'}). The oldest copy of each is kept.
          </p>
          <Preview items={groups.slice(0, 6).map((g) => g.item)} />
          <button className="primary" onClick={review}>
            Review {extras.toLocaleString()} extra cop{extras === 1 ? 'y' : 'ies'} →
          </button>
        </>
      )}
    </section>
  );
}

function TrashCard() {
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    const sub = liveQuery(() => db.trash.orderBy('deletedAt').reverse().toArray()).subscribe({ next: setEntries });
    return () => sub.unsubscribe();
  }, []);

  const batches = useMemo(() => {
    const map = new Map<number, TrashEntry[]>();
    for (const e of entries) map.set(e.deletedAt, [...(map.get(e.deletedAt) ?? []), e]);
    return [...map];
  }, [entries]);

  return (
    <section className="card" id="recently-removed">
      <h2>Recently removed</h2>
      <p>Bookmarks deleted here are kept for {TRASH_DAYS} days, then removed for good. Restoring puts them back in their original folder.</p>
      {batches.length === 0 ? <p className="note">Nothing yet.</p> : (
        <ul className="batches">
          {batches.map(([at, list]) => (
            <li key={at}>
              <div className="batch-head">
                <button className="link" aria-expanded={open === at} onClick={() => setOpen(open === at ? null : at)}>
                  {open === at ? '▾' : '▸'} {list.length.toLocaleString()} bookmark{list.length === 1 ? '' : 's'} · {relativeTime(at)}
                </button>
                <button onClick={() => void restoreFromTrash(list.map((e) => e.id!))}>Undo</button>
              </div>
              {open === at && (
                <ul className="batch-items">
                  {list.map((e) => (
                    <li key={e.id}>
                      <span className="title-text">{e.title}</span>
                      <span className="url">{displayUrl(e.url)}</span>
                      <button className="link" onClick={() => void restoreFromTrash([e.id!])}>Restore</button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Preview({ items }: { items: Item[] }) {
  if (!items.length) return null;
  return (
    <ul className="preview">
      {items.map((i) => (
        <li key={i.id}>
          <span className="title-text">{i.title}</span> <span className="url">{displayUrl(i.url)}</span>
        </li>
      ))}
    </ul>
  );
}
