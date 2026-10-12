import type { SaveInput } from './types';

/** Minimal shape of chrome.bookmarks.BookmarkTreeNode that we rely on. */
export interface BookmarkNode {
  id: string;
  title: string;
  url?: string;
  dateAdded?: number;
  children?: BookmarkNode[];
}

/** Turns the bookmark tree into save inputs, with "Bookmarks bar / Dev / Tools" style folder paths. */
export function flattenBookmarkTree(roots: BookmarkNode[]): SaveInput[] {
  const out: SaveInput[] = [];
  const walk = (node: BookmarkNode, path: string[]) => {
    if (node.url) {
      out.push({
        source: 'chrome',
        sourceId: node.id,
        url: node.url,
        title: node.title,
        folderPath: path.join(' / ') || undefined,
        savedAt: node.dateAdded,
      });
      return;
    }
    // The invisible root has an empty title; don't put it in paths.
    const next = node.title ? [...path, node.title] : path;
    for (const child of node.children ?? []) walk(child, next);
  };
  for (const root of roots) walk(root, []);
  return out;
}

/** Minimal shape of chrome.readingList.ReadingListEntry. */
export interface ReadingListEntry {
  url: string;
  title: string;
  hasBeenRead: boolean;
  creationTime: number;
}

export function readingListToInputs(entries: ReadingListEntry[]): SaveInput[] {
  return entries.map((e) => ({
    source: 'readinglist',
    // Reading List entries are keyed by URL; there is no other id.
    sourceId: e.url,
    url: e.url,
    title: e.title,
    folderPath: e.hasBeenRead ? 'Reading list / Read' : 'Reading list / Unread',
    savedAt: e.creationTime,
  }));
}
