import Dexie, { type EntityTable } from 'dexie';
import type { Item, Save, SourceState, TrashEntry, VectorRow } from './types';

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
  trash!: EntityTable<TrashEntry, 'id'>;
  vectors!: EntityTable<VectorRow, 'itemId'>;

  constructor(name = 'bookmarkie') {
    super(name);
    this.version(1).stores({
      items: '++id, &canonicalUrl, lastSavedAt, *sources, *colorBuckets, *tags, enrich.status',
      saves: '++id, &[source+sourceId], itemId, source, savedAt',
      sourceState: 'source',
      settings: 'key',
    });
    this.version(2).stores({
      trash: '++id, deletedAt',
      vectors: 'itemId',
    });
  }
}

export const db = new BookmarkieDB();

export async function getSetting<T>(key: string, fallback: T, database: BookmarkieDB = db): Promise<T> {
  const row = await database.settings.get(key);
  return row ? (row.value as T) : fallback;
}

export async function setSetting(key: string, value: unknown, database: BookmarkieDB = db): Promise<void> {
  await database.settings.put({ key, value });
}
