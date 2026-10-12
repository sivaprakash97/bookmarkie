import { canonicalize, guessKind, isWebUrl, siteNameOf } from './canonical';
import { db as defaultDb, type BookmarkieDB } from './db';
import type { Item, Save, SaveInput, Source } from './types';

export interface IngestResult {
  added: number;
  updated: number;
  removed: number;
}

export interface SnapshotOptions {
  /**
   * True when `inputs` is everything the source currently has (e.g. the whole
   * Chrome bookmark tree). Saves missing from it are marked removed.
   */
  complete: boolean;
  now?: number;
}

/**
 * Writes a batch of saves from one source, creating or merging items by
 * canonical URL, and recomputes the affected items' denormalized fields.
 */
export async function applySnapshot(
  source: Source,
  inputs: SaveInput[],
  opts: SnapshotOptions,
  database: BookmarkieDB = defaultDb,
): Promise<IngestResult> {
  const now = opts.now ?? Date.now();
  const result: IngestResult = { added: 0, updated: 0, removed: 0 };

  await database.transaction('rw', database.items, database.saves, async () => {
    const existing = new Map<string, Save>();
    for (const s of await database.saves.where('source').equals(source).toArray()) {
      existing.set(s.sourceId, s);
    }
    const itemIdByCanon = new Map<string, number>();
    const touched = new Set<number>();
    const seen = new Set<string>();

    const itemIdFor = async (url: string): Promise<number> => {
      const canon = canonicalize(url);
      const cached = itemIdByCanon.get(canon);
      if (cached !== undefined) return cached;
      const found = await database.items.where('canonicalUrl').equals(canon).first();
      const id = found?.id ?? ((await database.items.add(newItem(canon, url, now))) as number);
      itemIdByCanon.set(canon, id);
      return id;
    };

    for (const input of inputs) {
      if (input.source !== source || seen.has(input.sourceId)) continue;
      seen.add(input.sourceId);
      const itemId = await itemIdFor(input.url);
      const prev = existing.get(input.sourceId);

      if (!prev) {
        await database.saves.add({
          source,
          sourceId: input.sourceId,
          itemId,
          url: input.url,
          title: input.title,
          author: input.author,
          text: input.text,
          folderPath: input.folderPath,
          savedAt: input.savedAt ?? now,
          lastSeenAt: now,
        });
        touched.add(itemId);
        result.added++;
        continue;
      }

      const next: Save = {
        ...prev,
        itemId,
        url: input.url,
        title: input.title ?? prev.title,
        author: input.author ?? prev.author,
        text: input.text ?? prev.text,
        folderPath: input.folderPath ?? prev.folderPath,
        savedAt: input.savedAt ?? prev.savedAt,
        lastSeenAt: now,
        removedAt: undefined,
      };
      if (saveChanged(prev, next)) {
        touched.add(itemId);
        if (prev.itemId !== itemId) touched.add(prev.itemId);
        result.updated++;
        await database.saves.put(next);
      } else if (now - prev.lastSeenAt > SEEN_REFRESH_MS) {
        // Keep lastSeenAt roughly current without rewriting every row on every sync.
        await database.saves.update(prev.id!, { lastSeenAt: now });
      }
    }

    if (opts.complete) {
      for (const [sourceId, s] of existing) {
        if (seen.has(sourceId) || s.removedAt) continue;
        await database.saves.update(s.id!, { removedAt: now });
        touched.add(s.itemId);
        result.removed++;
      }
    }

    await recomputeItems(database, [...touched]);
  });

  return result;
}

/** Marks specific saves as removed (e.g. an unbookmark seen on X). */
export async function removeSaves(
  source: Source,
  sourceIds: string[],
  database: BookmarkieDB = defaultDb,
  now = Date.now(),
): Promise<number> {
  let removed = 0;
  await database.transaction('rw', database.items, database.saves, async () => {
    const touched = new Set<number>();
    for (const sourceId of sourceIds) {
      const s = await database.saves.where({ source, sourceId }).first();
      if (!s || s.removedAt) continue;
      await database.saves.update(s.id!, { removedAt: now });
      touched.add(s.itemId);
      removed++;
    }
    await recomputeItems(database, [...touched]);
  });
  return removed;
}

function newItem(canonicalUrl: string, url: string, now: number): Item {
  return {
    canonicalUrl,
    url,
    title: '',
    kind: guessKind(canonicalUrl),
    siteName: siteNameOf(url),
    sources: [],
    saveRefs: [],
    folderPaths: [],
    firstSavedAt: now,
    lastSavedAt: now,
    removed: false,
    tags: [],
    colorBuckets: [],
    enrich: { status: isWebUrl(url) ? 'pending' : 'none', attempts: 0 },
  };
}

const SEEN_REFRESH_MS = 60 * 60 * 1000;

const SAVE_FIELDS =['itemId', 'url', 'title', 'author', 'text', 'folderPath', 'savedAt', 'removedAt'] as const;

function saveChanged(a: Save, b: Save): boolean {
  return SAVE_FIELDS.some((f) => a[f] !== b[f]);
}

async function recomputeItems(database: BookmarkieDB, itemIds: number[]): Promise<void> {
  if (!itemIds.length) return;
  const saves = await database.saves.where('itemId').anyOf(itemIds).toArray();
  const byItem = new Map<number, Save[]>();
  for (const s of saves) {
    const list = byItem.get(s.itemId) ?? [];
    list.push(s);
    byItem.set(s.itemId, list);
  }
  const items = await database.items.bulkGet(itemIds);
  const puts: Item[] = [];
  const deletes: number[] = [];

  items.forEach((item, i) => {
    if (!item) return;
    const list = byItem.get(itemIds[i]!) ?? [];
    // Only reachable when every save moved to a different URL.
    if (!list.length) {
      deletes.push(item.id!);
      return;
    }
    puts.push(deriveItem(item, list));
  });

  if (puts.length) await database.items.bulkPut(puts);
  if (deletes.length) await database.items.bulkDelete(deletes);
}

export function deriveItem(item: Item, saves: Save[]): Item {
  const active = saves.filter((s) => !s.removedAt);
  const basis = (active.length ? active : saves).slice().sort((a, b) => b.savedAt - a.savedAt);
  const latest = basis[0]!;
  const withTitle = basis.find((s) => s.title?.trim());
  return {
    ...item,
    url: latest.url,
    title: withTitle?.title?.trim() || item.title || latest.url,
    author: basis.find((s) => s.author)?.author ?? item.author,
    text: basis.find((s) => s.text)?.text ?? item.text,
    siteName: siteNameOf(latest.url),
    sources: [...new Set(active.map((s) => s.source))],
    saveRefs: saves.map((s) => ({ source: s.source, savedAt: s.savedAt, removed: !!s.removedAt })),
    folderPaths: [...new Set(active.flatMap((s) => (s.folderPath ? [s.folderPath] : [])))],
    firstSavedAt: Math.min(...basis.map((s) => s.savedAt)),
    lastSavedAt: latest.savedAt,
    removed: active.length === 0,
  };
}
