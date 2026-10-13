import { useEffect, useMemo, useState } from 'react';
import { restoreFromTrash, type Candidate } from '@/core/cleanup';
import { SOURCES, type Source } from '@/core/types';
import { CleanupPanel } from './CleanupPanel';
import { relativeTime } from './format';
import { ReviewScreen } from './ReviewScreen';
import { SearchView } from './SearchView';
import { SourcesPanel } from './SourcesPanel';
import { useLibrary } from './useLibrary';

type View = 'search' | 'cleanup' | 'sources';

interface Toast {
  text: string;
  trashIds: number[];
}

const justUpdated = new URLSearchParams(location.search).has('updated');

/** Lets the background reload Bookmarkie as soon as a newer build is on disk. */
function askForUpdateCheck() {
  void browser.runtime.sendMessage({ type: 'check-update' }).catch(() => undefined);
}

export function App() {
  const { loaded, items, index, sourceStates } = useLibrary();
  const [view, setView] = useState<View>('search');
  const [review, setReview] = useState<{ candidates: Candidate[]; from: View } | null>(null);
  const [toast, setToast] = useState<Toast | null>(
    justUpdated ? { text: 'Bookmarkie was updated to the latest version.', trashIds: [] } : null,
  );

  useEffect(() => {
    if (justUpdated) history.replaceState(null, '', location.pathname);
    askForUpdateCheck();
    const onVisible = () => document.visibilityState === 'visible' && askForUpdateCheck();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
  const [resetKey, setResetKey] = useState(0);

  const counts = useMemo(() => {
    const c = Object.fromEntries(SOURCES.map((s) => [s, 0])) as Record<Source, number>;
    for (const item of items) for (const s of item.sources) c[s]++;
    return c;
  }, [items]);
  const itemsById = useMemo(() => new Map(items.map((i) => [i.id!, i])), [items]);
  const activeTotal = useMemo(() => items.filter((i) => !i.removed).length, [items]);
  const lastSync = Math.max(0, ...sourceStates.map((s) => s.lastSyncAt ?? 0));

  const openReview = (candidates: Candidate[]) => {
    if (!candidates.length) return;
    setToast(null);
    setReview({ candidates, from: view });
    window.scrollTo(0, 0);
  };

  const onDeleted = ({ deleted, trashIds }: { deleted: number; trashIds: number[] }) => {
    setView(review?.from ?? 'search');
    setReview(null);
    setResetKey((k) => k + 1);
    setToast({ text: `Deleted ${deleted.toLocaleString()} bookmark${deleted === 1 ? '' : 's'} from Chrome.`, trashIds });
  };

  const undo = async () => {
    if (!toast) return;
    const restored = await restoreFromTrash(toast.trashIds);
    setToast({ text: `Restored ${restored.toLocaleString()} bookmark${restored === 1 ? '' : 's'}.`, trashIds: [] });
  };

  return (
    <div className="page">
      <header className="top">
        <div className="brand">
          <img src="/icon/48.png" alt="" width={28} height={28} />
          <span>Bookmarkie</span>
        </div>
        {!review && (
          <nav className="tabs" aria-label="View">
            <button aria-pressed={view === 'search'} onClick={() => setView('search')}>Search</button>
            <button aria-pressed={view === 'cleanup'} onClick={() => setView('cleanup')}>Clean up</button>
            <button aria-pressed={view === 'sources'} onClick={() => setView('sources')}>Sources</button>
          </nav>
        )}
      </header>

      {toast && (
        <div className="toast" role="status">
          {toast.text}
          {toast.trashIds.length > 0 && <button className="link" onClick={() => void undo()}>Undo</button>}
          <button className="link dismiss" aria-label="Dismiss" onClick={() => setToast(null)}>×</button>
        </div>
      )}

      {review && (
        <ReviewScreen candidates={review.candidates} itemsById={itemsById}
          onCancel={() => setReview(null)} onDeleted={onDeleted} />
      )}

      {/* Views stay mounted so a search or a clean-up run survives switching tabs. */}
      <div hidden={!!review || view !== 'search'}>
        <SearchView loaded={loaded} items={items} index={index} counts={counts} onReview={openReview} resetKey={resetKey} />
      </div>
      <div hidden={!!review || view !== 'cleanup'}>
        <CleanupPanel items={items} onReview={openReview} />
      </div>
      <div hidden={!!review || view !== 'sources'}>
        <SourcesPanel states={sourceStates} counts={counts} />
      </div>

      <footer className="statusbar">
        {activeTotal.toLocaleString()} bookmarks
        {lastSync > 0 && <> · synced {relativeTime(lastSync)}</>}
        <span className="hint">
          <kbd>/</kbd> search · <kbd>↑</kbd><kbd>↓</kbd> move · <kbd>Enter</kbd> open · type <kbd>bm</kbd> in the address bar
        </span>
      </footer>
    </div>
  );
}
