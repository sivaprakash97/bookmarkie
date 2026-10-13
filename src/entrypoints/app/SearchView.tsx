import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { isOpenable } from '@/core/canonical';
import { candidatesFor, type Candidate } from '@/core/cleanup';
import { parseQuery, type Chip } from '@/core/queryParse';
import type { LexicalIndex } from '@/core/search/lexical';
import { SOURCE_LABELS, SOURCES, type Item, type Source } from '@/core/types';
import { canDelete, ResultRow } from './ResultRow';

const initialQuery = new URLSearchParams(location.search).get('q') ?? '';
const SHOWN = 200;

export function openItem(item: Item, background = false): void {
  if (!isOpenable(item.url)) return;
  void browser.tabs.create({ url: item.url, active: !background });
}

interface Props {
  loaded: boolean;
  items: Item[];
  index: LexicalIndex;
  counts: Record<Source, number>;
  onReview: (candidates: Candidate[]) => void;
  /** Bumped after a deletion so the selection is cleared. */
  resetKey: number;
}

export function SearchView({ loaded, items, index, counts, onReview, resetKey }: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [facet, setFacet] = useState<Source | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const [selected, setSelected] = useState(0);
  const [selecting, setSelecting] = useState(false);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLOListElement>(null);

  const deferredQuery = useDeferredValue(query);
  const parsed = useMemo(() => parseQuery(deferredQuery), [deferredQuery]);
  // Every match, so "Select all" covers more than the rows on screen.
  const allHits = useMemo(
    () => index.search(parsed, { sources: facet ? [facet] : undefined, includeRemoved: showRemoved, limit: Infinity }),
    [index, parsed, facet, showRemoved],
  );
  const hits = useMemo(() => allHits.slice(0, SHOWN), [allHits]);
  const selectable = useMemo(() => allHits.filter((h) => canDelete(h.item)), [allHits]);

  useEffect(() => setSelected(0), [parsed, facet, showRemoved]);
  useEffect(() => {
    setChecked(new Set());
    setSelecting(false);
  }, [resetKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement !== inputRef.current && !(e.target instanceof HTMLInputElement)) {
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

  const toggle = (id: number) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allChecked = selectable.length > 0 && selectable.every((h) => checked.has(h.item.id!));
  const selectAll = () =>
    setChecked((prev) => {
      const next = new Set(prev);
      for (const h of selectable) {
        if (allChecked) next.delete(h.item.id!);
        else next.add(h.item.id!);
      }
      return next;
    });

  const review = async () => {
    const label = query.trim() ? `You selected it (search: "${query.trim()}")` : 'You selected it';
    onReview(await candidatesFor([...checked], 'selected', () => label));
  };

  const visibleSources = SOURCES.filter((s) => counts[s] > 0);

  return (
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
          placeholder='Try "react hooks article", "linkedin last month", "before 2020"'
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
        <button className="select-toggle" aria-pressed={selecting} onClick={() => setSelecting((s) => !s)}>
          {selecting ? 'Done selecting' : 'Select'}
        </button>
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
              ? `${allHits.length.toLocaleString()} result${allHits.length === 1 ? '' : 's'}${allHits.length > SHOWN ? `, showing the top ${SHOWN}` : ''}`
              : 'Recently saved'}
            {selecting && selectable.length > 0 && (
              <button className="link select-all" onClick={selectAll}>
                {allChecked ? 'Unselect all' : `Select all ${selectable.length.toLocaleString()} results`}
              </button>
            )}
          </p>
          <ol id="results" className="results" ref={listRef}>
            {hits.map((hit, i) => (
              <ResultRow key={hit.item.id} hit={hit} selected={i === selected}
                onHover={() => setSelected(i)} onOpen={openItem}
                checked={selecting ? checked.has(hit.item.id!) : undefined}
                onCheck={selecting ? () => toggle(hit.item.id!) : undefined} />
            ))}
          </ol>
        </>
      )}

      {checked.size > 0 && (
        <div className="action-bar" role="region" aria-label="Selection">
          <span><strong>{checked.size.toLocaleString()}</strong> selected</span>
          <button className="link" onClick={() => setChecked(new Set())}>Clear</button>
          <button className="primary push" onClick={() => void review()}>Review &amp; remove →</button>
        </div>
      )}
    </main>
  );
}
