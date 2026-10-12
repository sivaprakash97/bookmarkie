import { SOURCE_LABELS, SOURCES, type Source, type SourceState } from '@/core/types';
import { relativeTime } from './format';

const DESCRIPTIONS: Record<Source, string> = {
  chrome: 'Synced automatically. Bookmarks you add, move, rename or delete show up within a second, including ones synced from your phone.',
  readinglist: "Chrome's Reading List, synced automatically.",
  x: 'Coming next: saves are captured as you bookmark tweets, plus an optional daily sync.',
  linkedin: 'Planned: saved posts captured as you save them, plus an optional daily sync.',
  instagram: 'Planned: saved posts and reels captured as you save them, plus an optional daily sync.',
};

const STATUS_LABEL: Record<string, string> = {
  ok: 'Connected',
  stale: 'Out of date',
  broken: 'Not working',
  'needs-login': 'Log in needed',
  paused: 'Paused',
  off: 'Off',
};

export function SourcesPanel({ states, counts }: { states: SourceState[]; counts: Record<Source, number> }) {
  const bySource = new Map(states.map((s) => [s.source, s]));
  return (
    <main className="sources">
      <h1>Sources</h1>
      <ul>
        {SOURCES.map((source) => {
          const state = bySource.get(source);
          const status = state?.status ?? (source === 'chrome' || source === 'readinglist' ? 'stale' : 'off');
          const planned = !state && source !== 'chrome' && source !== 'readinglist';
          return (
            <li key={source} className="source-card">
              <div className="source-head">
                <span className={`badge badge-${source}`}>{SOURCE_LABELS[source]}</span>
                <span className={`status status-${planned ? 'planned' : status}`}>
                  {planned ? 'Not yet available' : STATUS_LABEL[status]}
                </span>
              </div>
              <p>{DESCRIPTIONS[source]}</p>
              {state && (
                <p className="source-stats">
                  {counts[source].toLocaleString()} saved
                  {state.lastSyncAt && <> · last synced {relativeTime(state.lastSyncAt)}</>}
                  {state.lastError && <> · <span className="error">{state.lastError}</span></>}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </main>
  );
}
