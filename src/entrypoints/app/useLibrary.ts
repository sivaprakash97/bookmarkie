import { liveQuery } from 'dexie';
import { useEffect, useMemo, useState } from 'react';
import { db } from '@/core/db';
import { LexicalIndex } from '@/core/search/lexical';
import type { Item, SourceState } from '@/core/types';

function useLiveQuery<T>(query: () => Promise<T>, initial: T): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    const sub = liveQuery(query).subscribe({
      next: setValue,
      error: (err) => console.error('[bookmarkie] live query failed', err),
    });
    return () => sub.unsubscribe();
    // The query functions passed in are stable module-level reads.
  }, []);
  return value;
}

const allItems = () => db.items.toArray();
const allSourceStates = () => db.sourceState.toArray();

export interface Library {
  loaded: boolean;
  items: Item[];
  index: LexicalIndex;
  sourceStates: SourceState[];
}

/** Every item plus a search index, rebuilt whenever the database changes (any context). */
export function useLibrary(): Library {
  const items = useLiveQuery<Item[] | null>(allItems, null);
  const sourceStates = useLiveQuery<SourceState[]>(allSourceStates, []);
  const index = useMemo(() => new LexicalIndex(items ?? []), [items]);
  return { loaded: items !== null, items: items ?? [], index, sourceStates };
}
