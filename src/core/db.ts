import Dexie, { type EntityTable } from 'dexie';
import type { Item, Save, SourceState } from './types';

export interface Setting {
  key: string;
  value: unknown;
}

export class BookmarkieDB extends Dexie {
  items!: EntityTable<Item, 'id'>;
  saves!: EntityTable<Save, 'id'>;
  sourceState!: EntityTable<SourceState, 'source'>;
  /** Extension-origin only; content scripts can't read it (unlike chrome.storage.local). */
  settings!: EntityTable<Setting, 'key'>;

  constructor(name = 'bookmarkie') {
    super(name);
    this.version(1).stores({
      items: '++id, &canonicalUrl, lastSavedAt, *sources, *colorBuckets, *tags, enrich.status',
      saves: '++id, &[source+sourceId], itemId, source, savedAt',
      sourceState: 'source',
      settings: 'key',
    });
  }
}

export const db = new BookmarkieDB();
