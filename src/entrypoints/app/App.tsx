import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { isOpenable } from '@/core/canonical';
import { parseQuery, type Chip } from '@/core/queryParse';
import { SOURCE_LABELS, SOURCES, type Item, type Source } from '@/core/types';
import { relativeTime } from './format';
import { ResultRow } from './ResultRow';
import { SourcesPanel } from './SourcesPanel';
import { useLibrary } from './useLibrary';

const initialQuery = new URLSearchParams(location.search).get('q') ?? '';

export function openItem(item: Item, background = false): void {
  if (!isOpenable(item.url)) return;
  void browser.tabs.create({ url: item.url, active: !background });
}

export function App() {
  const { loaded, items, index, sourceStates } = useLibrary();
  const [query, setQuery] = useState(initialQuery);
  const [facet, setFacet] = useState<Source | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const [view, setView] = useState<'search' | 'sources'>('search');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLOListElement>(null);

  const deferredQuery = useDeferredValue(query);
  const parsed = useMemo(() => parseQuery(deferredQuery), [deferredQuery]);
  const hits = useMemo(
    () => index.search(parsed, { sources: facet ? [facet] : undefined, includeRemoved: showRemoved, limit: 200 }),
    [index, parsed, facet, showRemoved],
  );

  const counts = useMemo(() => {
    const c = Object.fromEntries(SOURCES.map((s) => [s, 0])) as Record<Source, number>;
    for (const item of items) for (const s of item.sources) c[s]++;
    return c;
  }, [items]);
  const activeTotal = useMemo(() => items.filter((i) => !i.removed).length, [items]);
  const lastSync = Math.max(0, ...sourceStates.map((s) => s.lastSyncAt ?? 0));

  useEffect(() => setSelected(0), [parsed, facet, showRemoved]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement !== inputRef.current) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, hits.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      const hit = hits[selected];
      if (hit) openItem(hit.item, e.metaKey || e.ctrlKey);
    } else if (e.key === 'Escape') {
      setQuery('');
    }
  };

  const removeChip = (chip: Chip) => {
    setQuery((q) => q.replace(chip.raw, ' ').replace(/\s+/g, ' ').trim());
    inputRef.current?.focus();
  };

  const visibleSources = SOURCES.filter((s) => counts[s] > 0);

  return (
    <div className="page">
      <header className="top">
        <div className="brand">
          <img src="/icon/48.png" alt="" width={28} height={28} />
          <span>Bookmarkie</span>
        </div>
        <nav className="tabs" aria-label="View">
          <button aria-pressed={view === 'search'} onClick={() => setView('search')}>Search</button>
          <button aria-pressed={view === 'sources'} onClick={() => setView('sources')}>Sources</button>
        </nav>
      </header>

      {view === 'sources' ? (
        <SourcesPanel states={sourceStates} counts={counts} />
      ) : (
        <main>
          <div className="search">
            <svg className="search-icon" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              ref={inputRef}
              autoFocus
              type="search"
              placeholder='Try "react hooks article", "linkedin last month", "recipes from 2024"'
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onInputKey}
              aria-label="Search bookmarks"
              aria-controls="results"
            />
          </div>

          <div className="filters">
            {parsed.chips.map((chip) => (
              <button key={chip.type + chip.raw} className={`chip chip-${chip.type}`} onClick={() => removeChip(chip)}
                title="Remove this filter">
                <span className="chip-kind">{chip.type === 'date' ? 'Saved' : chip.type === 'source' ? 'From' : 'Color'}</span>
                {chip.label}
                <span aria-hidden="true">×</span>
              </button>
            ))}
            {visibleSources.length > 1 && (
              <div className="facets" role="group" aria-label="Source">
                <button aria-pressed={facet === null} onClick={() => setFacet(null)}>All</button>
                {visibleSources.map((s) => (
                  <button key={s} aria-pressed={facet === s} onClick={() => setFacet(facet === s ? null : s)}>
                    {SOURCE_LABELS[s]} <span className="count">{counts[s].toLocaleString()}</span>
                  </button>
                ))}
              </div>
            )}
            <label className="toggle">
              <input type="checkbox" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} />
              Include removed
            </label>
          </div>

          {!loaded ? null : items.length === 0 ? (
            <div className="empty">
              <p><strong>Importing your Chrome bookmarks…</strong></p>
              <p>New bookmarks you add in Chrome show up here automatically.</p>
            </div>
          ) : hits.length === 0 ? (
            <div className="empty">
              <p><strong>Nothing matches.</strong></p>
              <p>Try fewer words, remove a filter, or tick "Include removed".</p>
            </div>
          ) : (
            <>
              <p className="summary" aria-live="polite">
                {parsed.text || parsed.chips.length
                  ? `${hits.length === 200 ? 'Top 200' : hits.length.toLocaleString()} result${hits.length === 1 ? '' : 's'}`
                  : 'Recently saved'}
              </p>
              <ol id="results" className="results" ref={listRef}>
                {hits.map((hit, i) => (
                  <ResultRow key={hit.item.id} hit={hit} selected={i === selected}
                    onHover={() => setSelected(i)} onOpen={openItem} />
                ))}
              </ol>
            </>
          )}
        </main>
      )}

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

