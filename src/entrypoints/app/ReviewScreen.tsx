import { useEffect, useMemo, useState } from 'react';
import {
  deleteFromChrome,
  downloadFile,
  exportBookmarksHtml,
  toCsv,
  type Candidate,
  type DeleteProgress,
  type ReasonKind,
} from '@/core/cleanup';
import type { BookmarkNode } from '@/core/chromeSource';
import { db, getSetting, setSetting } from '@/core/db';
import { isOpenable } from '@/core/canonical';
import type { Item, Save } from '@/core/types';
import { absoluteDate, displayUrl, faviconUrl } from './format';

const KIND_LABEL: Record<ReasonKind, string> = {
  selected: 'Selected',
  topic: 'Not about your topics',
  dead: 'Dead link',
  unsure: "Couldn't check",
  duplicate: 'Extra copy',
};

type Sort = 'reason' | 'oldest' | 'newest' | 'folder' | 'title';

interface Row {
  key: string;
  candidate: Candidate;
  item: Item;
  title: string;
  url: string;
  folder: string;
  savedAt: number;
}

interface Props {
  candidates: Candidate[];
  itemsById: Map<number, Item>;
  onCancel: () => void;
  onDeleted: (result: { deleted: number; trashIds: number[] }) => void;
}

export async function downloadBackup(): Promise<void> {
  const tree = (await browser.bookmarks.getTree()) as BookmarkNode[];
  const date = new Date().toISOString().slice(0, 10);
  downloadFile(`bookmarks-backup-${date}.html`, exportBookmarksHtml(tree), 'text/html');
  await setSetting('lastBackupAt', Date.now());
}

export function ReviewScreen({ candidates, itemsById, onCancel, onDeleted }: Props) {
  const [saves, setSaves] = useState<Map<number, Save> | null>(null);
  const [unticked, setUnticked] = useState<Set<string>>(
    () => new Set(candidates.filter((c) => !c.preselected).map(keyOf)),
  );
  const [kindFilter, setKindFilter] = useState<ReasonKind | 'all'>('all');
  const [sort, setSort] = useState<Sort>('reason');
  const [askBackup, setAskBackup] = useState(false);
  const [progress, setProgress] = useState<DeleteProgress | null>(null);

  useEffect(() => {
    void db.saves.bulkGet(candidates.flatMap((c) => c.saveIds)).then((list) => {
      setSaves(new Map(list.filter((s): s is Save => !!s).map((s) => [s.id!, s])));
    });
  }, [candidates]);

  const rows = useMemo<Row[]>(() => {
    if (!saves) return [];
    return candidates.flatMap((candidate) => {
      const item = itemsById.get(candidate.itemId);
      if (!item) return [];
      const first = saves.get(candidate.saveIds[0]!);
      return [{
        key: keyOf(candidate),
        candidate,
        item,
        title: first?.title || item.title,
        url: first?.url ?? item.url,
        folder: candidate.saveIds.map((id) => saves.get(id)?.folderPath).filter(Boolean).join(' · '),
        savedAt: first?.savedAt ?? item.lastSavedAt,
      }];
    });
  }, [candidates, itemsById, saves]);

  const kinds = useMemo(() => [...new Set(candidates.map((c) => c.kind))], [candidates]);
  const shown = useMemo(() => {
    const list = kindFilter === 'all' ? rows : rows.filter((r) => r.candidate.kind === kindFilter);
    const by: Record<Sort, (a: Row, b: Row) => number> = {
      reason: (a, b) => kinds.indexOf(a.candidate.kind) - kinds.indexOf(b.candidate.kind) || a.savedAt - b.savedAt,
      oldest: (a, b) => a.savedAt - b.savedAt,
      newest: (a, b) => b.savedAt - a.savedAt,
      folder: (a, b) => a.folder.localeCompare(b.folder) || a.title.localeCompare(b.title),
      title: (a, b) => a.title.localeCompare(b.title),
    };
    return list.slice().sort(by[sort]);
  }, [rows, kindFilter, sort, kinds]);

  const ticked = rows.filter((r) => !unticked.has(r.key));
  const toggle = (key: string) =>
    setUnticked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const setAllShown = (tick: boolean) =>
    setUnticked((prev) => {
      const next = new Set(prev);
      for (const r of shown) {
        if (tick) next.delete(r.key);
        else next.add(r.key);
      }
      return next;
    });

  const downloadList = () => {
    const csv = toCsv([
      ['Delete?', 'Title', 'Address', 'Folder', 'Saved', 'Reason'],
      ...rows.map((r) => [
        unticked.has(r.key) ? 'keep' : 'delete',
        r.title,
        r.url,
        r.folder,
        new Date(r.savedAt).toISOString().slice(0, 10),
        `${KIND_LABEL[r.candidate.kind]}: ${r.candidate.reason}`,
      ]),
    ]);
    downloadFile('bookmarks-to-delete.csv', csv, 'text/csv');
  };

  const startDelete = async () => {
    if (!(await getSetting<number | null>('lastBackupAt', null))) setAskBackup(true);
    else await runDelete();
  };

  const runDelete = async (withBackup = false) => {
    setAskBackup(false);
    if (withBackup) await downloadBackup();
    setProgress({ done: 0, total: ticked.length });
    const result = await deleteFromChrome(ticked.map((r) => r.candidate), setProgress);
    onDeleted(result);
  };

  if (!saves) return <main className="review"><p className="summary">Loading…</p></main>;

  return (
    <main className="review">
      <h1>Review before deleting</h1>
      <p className="lead">
        These bookmarks will be deleted from Chrome. Untick any you want to keep.
        Nothing is deleted until you press the button at the bottom, and you can undo for 30 days.
      </p>

      <div className="review-tools">
        {kinds.length > 1 && (
          <label>
            Show{' '}
            <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value as ReasonKind | 'all')}>
              <option value="all">All reasons ({rows.length})</option>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]} ({rows.filter((r) => r.candidate.kind === k).length})
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Sort{' '}
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="reason">By reason</option>
            <option value="oldest">Oldest first</option>
            <option value="newest">Newest first</option>
            <option value="folder">By folder</option>
            <option value="title">By title</option>
          </select>
        </label>
        <button className="link" onClick={() => setAllShown(true)}>Tick all</button>
        <button className="link" onClick={() => setAllShown(false)}>Untick all</button>
        <button className="link push" onClick={downloadList}>Download this list (CSV)</button>
      </div>

      <ol className="review-list">
        {shown.map((r) => (
          <li key={r.key} className={unticked.has(r.key) ? 'kept' : ''}>
            <input
              type="checkbox"
              checked={!unticked.has(r.key)}
              onChange={() => toggle(r.key)}
              aria-label={`Delete ${r.title}`}
            />
            <img className="favicon" src={faviconUrl(r.url)} alt="" width={16} height={16} loading="lazy" />
            <div className="row-body">
              <div className="review-title">
                <span className="title-text">{r.title}</span>
                {isOpenable(r.url) && (
                  <a href={r.url} target="_blank" rel="noopener noreferrer" className="open">Open ↗</a>
                )}
              </div>
              <div className="url">{displayUrl(r.url)}</div>
              <div className="meta">
                <span className={`reason reason-${r.candidate.kind}`}>{KIND_LABEL[r.candidate.kind]}</span>
                <span className="reason-detail">{r.candidate.reason}</span>
                {r.folder && <span className="folder" title={r.folder}>{r.folder}</span>}
                <span className="date">Saved {absoluteDate(r.savedAt)}</span>
              </div>
            </div>
          </li>
        ))}
      </ol>

      <div className="action-bar" role="region" aria-label="Delete">
        {progress ? (
          <div className="deleting" aria-live="polite">
            Deleting {progress.done.toLocaleString()} of {progress.total.toLocaleString()}…
            <progress value={progress.done} max={progress.total} />
          </div>
        ) : askBackup ? (
          <div className="backup-ask">
            <p>
              <strong>Download a backup first?</strong> It's a bookmarks file you can import into Chrome to get
              everything back, even after 30 days.
            </p>
            <div className="buttons">
              <button className="primary" onClick={() => void runDelete(true)}>Download backup, then delete</button>
              <button onClick={() => void runDelete(false)}>Delete without backup</button>
              <button className="link" onClick={() => setAskBackup(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <>
            <button onClick={onCancel}>← Back, delete nothing</button>
            <span className="kept-count">
              {rows.length - ticked.length > 0 && `Keeping ${(rows.length - ticked.length).toLocaleString()}`}
            </span>
            <button className="danger" disabled={!ticked.length} onClick={() => void startDelete()}>
              Delete {ticked.length.toLocaleString()} bookmark{ticked.length === 1 ? '' : 's'} from Chrome
            </button>
          </>
        )}
      </div>
    </main>
  );
}

function keyOf(c: Candidate): string {
  return `${c.itemId}:${c.saveIds.join(',')}`;
}
