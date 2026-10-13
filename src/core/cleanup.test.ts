import { beforeEach, describe, expect, it } from 'vitest';
import type { BookmarkNode } from './chromeSource';
import { flattenBookmarkTree } from './chromeSource';
import {
  candidatesFor,
  deleteFromChrome,
  exportBookmarksHtml,
  findDuplicates,
  purgeTrash,
  restoreFromTrash,
  toCsv,
} from './cleanup';
import { BookmarkieDB } from './db';
import { applySnapshot } from './ingest';

/** Just enough of chrome.bookmarks / readingList, backed by an in-memory tree. */
function fakeChrome() {
  let nextId = 100;
  const root: BookmarkNode & { parentId?: string } = {
    id: '0', title: '', children: [
      { id: '1', title: 'Bookmarks bar', children: [] },
      { id: '2', title: 'Other bookmarks', children: [] },
    ],
  };
  const all = new Map<string, BookmarkNode & { parentId?: string }>();
  const index = (n: BookmarkNode & { parentId?: string }) => {
    all.set(n.id, n);
    n.children?.forEach((c) => index(Object.assign(c, { parentId: n.id })));
  };
  index(root);
  const reading: { url: string; title: string }[] = [];
  const api = {
    bookmarks: {
      async getTree() { return [root]; },
      async get(id: string) {
        const n = all.get(id);
        if (!n) throw new Error("Can't find bookmark for id.");
        const parent = all.get(n.parentId!)!;
        return [{ ...n, index: parent.children!.indexOf(n) }];
      },
      async getChildren(id: string) {
        const n = all.get(id);
        if (!n) throw new Error("Can't find parent bookmark for id.");
        return n.children ?? [];
      },
      async create(b: { parentId?: string; index?: number; title: string; url?: string }) {
        const parent = all.get(b.parentId ?? '2');
        if (!parent) throw new Error("Can't find parent bookmark for id.");
        const node: BookmarkNode & { parentId?: string } = { id: String(nextId++), title: b.title, url: b.url, parentId: parent.id, children: b.url ? undefined : [] };
        parent.children!.splice(b.index ?? parent.children!.length, 0, node);
        all.set(node.id, node);
        return node;
      },
      async remove(id: string) {
        const n = all.get(id)!;
        const parent = all.get(n.parentId!)!;
        parent.children!.splice(parent.children!.indexOf(n), 1);
        all.delete(id);
      },
    },
    readingList: {
      async removeEntry({ url }: { url: string }) { reading.splice(reading.findIndex((e) => e.url === url), 1); },
      async addEntry(e: { url: string; title: string }) { reading.push(e); },
    },
  };
  return { api: api as never, raw: api, root, reading, add: (parentId: string, title: string, url: string) => api.bookmarks.create({ parentId, title, url }) };
}

let db: BookmarkieDB;
let n = 0;
beforeEach(() => {
  db = new BookmarkieDB(`cleanup-${n++}`);
});

async function sync(chrome: ReturnType<typeof fakeChrome>) {
  await applySnapshot('chrome', flattenBookmarkTree([chrome.root]), { complete: true }, db);
}

describe('deleteFromChrome / restoreFromTrash', () => {
  it('deletes only what was asked, keeps a trash copy, and restores to the same spot', async () => {
    const chrome = fakeChrome();
    const dev = await chrome.raw.bookmarks.create({ parentId: '1', title: 'Dev' });
    await chrome.add(dev.id, 'Keep me', 'https://keep.dev/');
    await chrome.add(dev.id, 'Old junk', 'https://junk.dev/');
    await chrome.add(dev.id, 'Also keep', 'https://also.dev/');
    await sync(chrome);

    const junk = (await db.items.where('canonicalUrl').equals('https://junk.dev').first())!;
    const candidates = await candidatesFor([junk.id!], 'selected', () => 'You selected it', db);
    const { deleted, trashIds } = await deleteFromChrome(candidates, undefined, chrome.api, db, 1000);

    expect(deleted).toBe(1);
    expect(dev.children!.map((c) => c.title)).toEqual(['Keep me', 'Also keep']);
    expect(await db.items.get(junk.id!)).toMatchObject({ removed: true });
    expect(await db.trash.toArray()).toMatchObject([
      { title: 'Old junk', parentId: dev.id, index: 1, folderPath: 'Bookmarks bar / Dev', reason: 'You selected it' },
    ]);

    expect(await restoreFromTrash(trashIds, chrome.api, db)).toBe(1);
    expect(dev.children!.map((c) => c.title)).toEqual(['Keep me', 'Old junk', 'Also keep']);
    expect(await db.trash.count()).toBe(0);
  });

  it('restores into a fallback folder when the original folder is gone', async () => {
    const chrome = fakeChrome();
    const folder = await chrome.raw.bookmarks.create({ parentId: '1', title: 'College' });
    await chrome.add(folder.id, 'Old notes', 'https://notes.dev/');
    await sync(chrome);
    const item = (await db.items.toArray())[0]!;
    const { trashIds } = await deleteFromChrome(await candidatesFor([item.id!], 'selected', () => '', db), undefined, chrome.api, db);
    await chrome.raw.bookmarks.remove(folder.id);

    await restoreFromTrash(trashIds, chrome.api, db);
    const other = chrome.root.children![1]!;
    expect(other.children!.map((c) => c.title)).toEqual(['Restored by Bookmarkie']);
    expect(other.children![0]!.children!.map((c) => c.title)).toEqual(['Old notes']);
  });

  it('skips bookmarks already deleted elsewhere without keeping a trash copy', async () => {
    const chrome = fakeChrome();
    const b = await chrome.add('1', 'Gone', 'https://gone.dev/');
    await sync(chrome);
    await chrome.raw.bookmarks.remove(b.id);
    const item = (await db.items.toArray())[0]!;
    const result = await deleteFromChrome(await candidatesFor([item.id!], 'selected', () => '', db), undefined, chrome.api, db);
    expect(result).toEqual({ deleted: 0, trashIds: [] });
    expect(await db.trash.count()).toBe(0);
    expect(await db.items.get(item.id!)).toMatchObject({ removed: true });
  });

  it('removes Reading List entries too', async () => {
    const chrome = fakeChrome();
    chrome.reading.push({ url: 'https://read.dev/', title: 'Later' });
    await applySnapshot('readinglist', [{ source: 'readinglist', sourceId: 'https://read.dev/', url: 'https://read.dev/' }], { complete: true }, db);
    const item = (await db.items.toArray())[0]!;
    const { trashIds } = await deleteFromChrome(await candidatesFor([item.id!], 'dead', () => '404', db), undefined, chrome.api, db);
    expect(chrome.reading).toEqual([]);
    await restoreFromTrash(trashIds, chrome.api, db);
    expect(chrome.reading.map((e) => e.url)).toEqual(['https://read.dev/']);
  });
});

describe('findDuplicates', () => {
  it('groups copies of the same link and keeps the oldest', async () => {
    await applySnapshot('chrome', [
      { source: 'chrome', sourceId: 'a', url: 'https://dup.dev/page?utm_source=x', savedAt: 3 },
      { source: 'chrome', sourceId: 'b', url: 'https://www.dup.dev/page/', savedAt: 1 },
      { source: 'chrome', sourceId: 'c', url: 'https://dup.dev/page', savedAt: 2 },
      { source: 'chrome', sourceId: 'd', url: 'https://single.dev/', savedAt: 1 },
    ], { complete: true }, db);
    const groups = await findDuplicates(db);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.keep.sourceId).toBe('b');
    expect(groups[0]!.extras.map((s) => s.sourceId)).toEqual(['c', 'a']);
  });
});

describe('purgeTrash', () => {
  it('drops entries older than 30 days', async () => {
    const day = 86_400_000;
    await db.trash.bulkAdd([
      { deletedAt: 0, source: 'chrome', sourceId: '1', itemId: 1, url: 'https://a', title: 'a', reason: '' },
      { deletedAt: 40 * day, source: 'chrome', sourceId: '2', itemId: 2, url: 'https://b', title: 'b', reason: '' },
    ]);
    expect(await purgeTrash(db, 45 * day)).toBe(1);
    expect((await db.trash.toArray()).map((e) => e.title)).toEqual(['b']);
  });
});

describe('exportBookmarksHtml', () => {
  it('writes the Netscape format with folders and escaped text', () => {
    const html = exportBookmarksHtml([{ id: '0', title: '', children: [
      { id: '1', title: 'Bookmarks bar', children: [
        { id: '2', title: 'Tom & Jerry <3', url: 'https://a.dev/?x="1"', dateAdded: 1_600_000_000_000 },
      ] },
    ] }]);
    expect(html).toContain('<!DOCTYPE NETSCAPE-Bookmark-file-1>');
    expect(html).toContain('<DT><H3>Bookmarks bar</H3>');
    expect(html).toContain('<DT><A HREF="https://a.dev/?x=&quot;1&quot;" ADD_DATE="1600000000">Tom &amp; Jerry &lt;3</A>');
  });
});

describe('toCsv', () => {
  it('quotes commas and quotes, and defuses spreadsheet formulas', () => {
    expect(toCsv([['a,b', 'say "hi"', '=HYPERLINK("x")', 'plain']])).toBe(
      '"a,b","say ""hi""","\'=HYPERLINK(""x"")",plain\r\n',
    );
  });
});

describe('restoring several bookmarks from one folder', () => {
  it('puts them back in their original order', async () => {
    const chrome = fakeChrome();
    const f = await chrome.raw.bookmarks.create({ parentId: '1', title: 'F' });
    for (const t of ['a', 'b', 'c', 'd']) await chrome.add(f.id, t, `https://${t}.dev/`);
    await sync(chrome);
    const ids = (await db.items.toArray()).filter((i) => ['https://a.dev', 'https://b.dev', 'https://d.dev'].includes(i.canonicalUrl)).map((i) => i.id!);
    const { trashIds } = await deleteFromChrome(await candidatesFor(ids, 'selected', () => '', db), undefined, chrome.api, db);
    expect(f.children!.map((c) => c.title)).toEqual(['c']);
    await restoreFromTrash(trashIds, chrome.api, db);
    expect(f.children!.map((c) => c.title)).toEqual(['a', 'b', 'c', 'd']);
  });
});
