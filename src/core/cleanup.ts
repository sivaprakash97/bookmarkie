import { browser } from 'wxt/browser';
import type { BookmarkNode } from './chromeSource';
import { db as defaultDb, type BookmarkieDB } from './db';
import { removeSaves } from './ingest';
import type { Item, Save, TrashEntry } from './types';

export const TRASH_DAYS = 30;
const RESTORE_FOLDER = 'Restored by Bookmarkie';

export type ReasonKind = 'selected' | 'topic' | 'dead' | 'unsure' | 'duplicate';

/** One bookmark proposed for deletion, shown on the Review screen before anything happens. */
export interface Candidate {
  itemId: number;
  /** The exact Chrome / Reading List saves to delete. Duplicates name only the extra copies. */
  saveIds: number[];
  kind: ReasonKind;
  reason: string;
  /** Ticked when the Review screen opens. "Couldn't check" links start unticked. */
  preselected: boolean;
}

type Api = Pick<typeof browser, 'bookmarks' | 'readingList'>;

const DELETABLE = new Set(['chrome', 'readinglist']);

/** Active Chrome and Reading List saves, the only ones Bookmarkie can delete for now. */
export async function deletableSaves(itemIds: number[], database: BookmarkieDB = defaultDb): Promise<Map<number, Save[]>> {
  const saves = await database.saves.where('itemId').anyOf(itemIds).toArray();
  const byItem = new Map<number, Save[]>();
  for (const s of saves) {
    if (s.removedAt || !DELETABLE.has(s.source)) continue;
    byItem.set(s.itemId, [...(byItem.get(s.itemId) ?? []), s]);
  }
  return byItem;
}

export async function candidatesFor(
  itemIds: number[],
  kind: ReasonKind,
  reason: (itemId: number) => string,
  database: BookmarkieDB = defaultDb,
): Promise<Candidate[]> {
  const byItem = await deletableSaves(itemIds, database);
  return itemIds.flatMap((itemId) => {
    const saves = byItem.get(itemId);
    if (!saves?.length) return [];
    return [{ itemId, saveIds: saves.map((s) => s.id!), kind, reason: reason(itemId), preselected: kind !== 'unsure' }];
  });
}

export interface DeleteProgress {
  done: number;
  total: number;
}

/**
 * Deletes the given saves from Chrome, keeping a copy of each in `trash` first.
 * Saves that are already gone from Chrome are just marked removed.
 */
export async function deleteFromChrome(
  candidates: Candidate[],
  onProgress?: (p: DeleteProgress) => void,
  api: Api = browser,
  database: BookmarkieDB = defaultDb,
  now = Date.now(),
): Promise<{ deleted: number; trashIds: number[] }> {
  const reasonBySave = new Map<number, string>();
  for (const c of candidates) for (const id of c.saveIds) reasonBySave.set(id, c.reason);
  const saves = (await database.saves.bulkGet([...reasonBySave.keys()])).filter(
    (s): s is Save => !!s && !s.removedAt && DELETABLE.has(s.source),
  );

  // Record every position first: deleting one bookmark shifts its siblings' indexes.
  const places = new Map<string, { parentId?: string; index?: number }>();
  for (const save of saves) {
    if (save.source !== 'chrome') continue;
    try {
      const [node] = await api.bookmarks.get(save.sourceId);
      if (node) places.set(save.sourceId, { parentId: node.parentId, index: node.index });
    } catch {
      // Already gone from Chrome.
    }
  }

  let deleted = 0;
  const trashIds: number[] = [];
  const removed: Record<'chrome' | 'readinglist', string[]> = { chrome: [], readinglist: [] };
  for (const [i, save] of saves.entries()) {
    const source = save.source as 'chrome' | 'readinglist';
    const entry: TrashEntry = {
      deletedAt: now,
      source,
      sourceId: save.sourceId,
      itemId: save.itemId,
      url: save.url,
      title: save.title ?? save.url,
      folderPath: save.folderPath,
      dateAdded: save.savedAt,
      reason: reasonBySave.get(save.id!) ?? '',
    };
    let trashId: number | undefined;
    try {
      if (source === 'chrome') {
        const place = places.get(save.sourceId);
        if (!place) throw new Error('Already deleted');
        Object.assign(entry, place);
      }
      // Keep the copy before deleting, so a crash mid-way never loses a bookmark.
      trashId = (await database.trash.add(entry)) as number;
      if (source === 'chrome') await api.bookmarks.remove(save.sourceId);
      else await api.readingList.removeEntry({ url: save.url });
      deleted++;
      trashIds.push(trashId);
    } catch {
      // Already deleted outside Bookmarkie: nothing to restore later.
      if (trashId !== undefined) await database.trash.delete(trashId);
    }
    removed[source].push(save.sourceId);
    onProgress?.({ done: i + 1, total: saves.length });
  }

  // Update the library now rather than waiting for the background sync to notice.
  await removeSaves('chrome', removed.chrome, database, now);
  await removeSaves('readinglist', removed.readinglist, database, now);
  return { deleted, trashIds };
}

/** Puts deleted bookmarks back where they were (or in a "Restored by Bookmarkie" folder). */
export async function restoreFromTrash(
  trashIds: number[],
  api: Api = browser,
  database: BookmarkieDB = defaultDb,
): Promise<number> {
  const entries = (await database.trash.bulkGet(trashIds)).filter((e): e is TrashEntry => !!e);
  // Restore lowest positions first so original indexes line up again.
  entries.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  let fallbackFolder: string | undefined;
  let restored = 0;

  for (const e of entries) {
    if (e.source === 'readinglist') {
      try {
        await api.readingList.addEntry({ url: e.url, title: e.title, hasBeenRead: false });
      } catch {
        // Already back in the Reading List.
      }
    } else {
      try {
        const siblings = e.parentId ? await api.bookmarks.getChildren(e.parentId) : [];
        await api.bookmarks.create({
          parentId: e.parentId,
          index: Math.min(e.index ?? siblings.length, siblings.length),
          title: e.title,
          url: e.url,
        });
      } catch {
        fallbackFolder ??= await restoreFolder(api);
        await api.bookmarks.create({ parentId: fallbackFolder, title: e.title, url: e.url });
      }
    }
    await database.trash.delete(e.id!);
    restored++;
  }
  return restored;
}

async function restoreFolder(api: Api): Promise<string> {
  const [root] = (await api.bookmarks.getTree()) as BookmarkNode[];
  // Chrome's roots are Bookmarks bar, Other bookmarks, Mobile bookmarks.
  const other = root?.children?.[1] ?? root?.children?.[0];
  const existing = other?.children?.find((c) => !c.url && c.title === RESTORE_FOLDER);
  if (existing) return existing.id;
  const created = await api.bookmarks.create({ parentId: other?.id, title: RESTORE_FOLDER });
  return created.id;
}

export async function purgeTrash(database: BookmarkieDB = defaultDb, now = Date.now()): Promise<number> {
  return database.trash.where('deletedAt').below(now - TRASH_DAYS * 86_400_000).delete();
}

export interface DuplicateGroup {
  item: Item;
  keep: Save;
  extras: Save[];
}

/** Links bookmarked more than once in Chrome. Keeps the oldest copy by default. */
export async function findDuplicates(database: BookmarkieDB = defaultDb): Promise<DuplicateGroup[]> {
  const saves = await database.saves.where('source').equals('chrome').filter((s) => !s.removedAt).toArray();
  const byItem = new Map<number, Save[]>();
  for (const s of saves) byItem.set(s.itemId, [...(byItem.get(s.itemId) ?? []), s]);
  const dupIds = [...byItem].filter(([, list]) => list.length > 1).map(([id]) => id);
  const items = await database.items.bulkGet(dupIds);
  return dupIds.flatMap((id, i) => {
    const item = items[i];
    if (!item) return [];
    const [keep, ...extras] = byItem.get(id)!.slice().sort((a, b) => a.savedAt - b.savedAt);
    return [{ item, keep: keep!, extras }];
  });
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** The Netscape bookmark file format every browser can import. */
export function exportBookmarksHtml(tree: BookmarkNode[]): string {
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
  ];
  const secs = (t?: number) => (t ? ` ADD_DATE="${Math.floor(t / 1000)}"` : '');
  const walk = (node: BookmarkNode, depth: number) => {
    const pad = '    '.repeat(depth);
    if (node.url) {
      lines.push(`${pad}<DT><A HREF="${escapeHtml(node.url)}"${secs(node.dateAdded)}>${escapeHtml(node.title)}</A>`);
      return;
    }
    lines.push(`${pad}<DT><H3${secs(node.dateAdded)}>${escapeHtml(node.title)}</H3>`, `${pad}<DL><p>`);
    for (const child of node.children ?? []) walk(child, depth + 1);
    lines.push(`${pad}</DL><p>`);
  };
  // Skip the invisible root; write its folders at the top level.
  for (const root of tree) for (const child of root.children ?? []) walk(child, 1);
  lines.push('</DL><p>', '');
  return lines.join('\n');
}

export function toCsv(rows: (string | number | undefined)[][]): string {
  const cell = (v: string | number | undefined) => {
    const s = v === undefined ? '' : String(v);
    // Quote everything that could break a row; prefix formula-like cells so spreadsheets don't run them.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) || safe !== s ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** Saves text as a file through a temporary link; needs no extra permission. */
export function downloadFile(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
