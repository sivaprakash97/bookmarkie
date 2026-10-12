import { beforeEach, describe, expect, it } from 'vitest';
import { BookmarkieDB } from './db';
import { applySnapshot, removeSaves } from './ingest';
import type { SaveInput } from './types';

let db: BookmarkieDB;
let n = 0;
beforeEach(() => {
  db = new BookmarkieDB(`test-${n++}`);
});

const chrome = (sourceId: string, url: string, extra: Partial<SaveInput> = {}): SaveInput => ({
  source: 'chrome', sourceId, url, title: `Title ${sourceId}`, savedAt: 1000, ...extra,
});

describe('applySnapshot', () => {
  it('adds items and saves', async () => {
    const r = await applySnapshot('chrome', [chrome('1', 'https://a.dev/'), chrome('2', 'https://b.dev/')], { complete: true }, db);
    expect(r).toEqual({ added: 2, updated: 0, removed: 0 });
    const items = await db.items.toArray();
    expect(items.map((i) => i.canonicalUrl).sort()).toEqual(['https://a.dev', 'https://b.dev']);
    expect(items[0]).toMatchObject({ sources: ['chrome'], removed: false, enrich: { status: 'pending' } });
  });

  it('is idempotent', async () => {
    const input = [chrome('1', 'https://a.dev/', { folderPath: 'Bar' })];
    await applySnapshot('chrome', input, { complete: true }, db);
    const r = await applySnapshot('chrome', input, { complete: true }, db);
    expect(r).toEqual({ added: 0, updated: 0, removed: 0 });
    expect(await db.items.count()).toBe(1);
    expect(await db.saves.count()).toBe(1);
  });

  it('marks missing saves removed on a complete snapshot, and restores them', async () => {
    await applySnapshot('chrome', [chrome('1', 'https://a.dev/'), chrome('2', 'https://b.dev/')], { complete: true }, db);
    const r = await applySnapshot('chrome', [chrome('1', 'https://a.dev/')], { complete: true, now: 5000 }, db);
    expect(r.removed).toBe(1);
    const b = await db.items.where('canonicalUrl').equals('https://b.dev').first();
    expect(b).toMatchObject({ removed: true, sources: [], saveRefs: [{ source: 'chrome', removed: true }] });

    await applySnapshot('chrome', [chrome('1', 'https://a.dev/'), chrome('2', 'https://b.dev/')], { complete: true }, db);
    expect(await db.items.where('canonicalUrl').equals('https://b.dev').first()).toMatchObject({ removed: false, sources: ['chrome'] });
  });

  it('does not remove anything on a partial snapshot', async () => {
    await applySnapshot('chrome', [chrome('1', 'https://a.dev/'), chrome('2', 'https://b.dev/')], { complete: true }, db);
    const r = await applySnapshot('chrome', [chrome('3', 'https://c.dev/')], { complete: false }, db);
    expect(r).toEqual({ added: 1, updated: 0, removed: 0 });
    expect((await db.items.toArray()).filter((i) => i.removed)).toHaveLength(0);
  });

  it('merges the same link from two sources into one item', async () => {
    await applySnapshot('chrome', [chrome('1', 'https://twitter.com/jane/status/42?s=20')], { complete: true }, db);
    await applySnapshot('x', [{ source: 'x', sourceId: '42', url: 'https://x.com/jane/status/42', author: '@jane', savedAt: 2000 }], { complete: false }, db);
    const items = await db.items.toArray();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      canonicalUrl: 'https://x.com/i/status/42',
      kind: 'post',
      author: '@jane',
      lastSavedAt: 2000,
      firstSavedAt: 1000,
    });
    expect(items[0]!.sources.sort()).toEqual(['chrome', 'x']);
  });

  it('re-points a save whose URL was edited, and drops the orphaned item', async () => {
    await applySnapshot('chrome', [chrome('1', 'https://old.dev/')], { complete: true }, db);
    const r = await applySnapshot('chrome', [chrome('1', 'https://new.dev/')], { complete: true }, db);
    expect(r.updated).toBe(1);
    expect((await db.items.toArray()).map((i) => i.canonicalUrl)).toEqual(['https://new.dev']);
  });

  it('keeps folder paths and title updates', async () => {
    await applySnapshot('chrome', [chrome('1', 'https://a.dev/', { folderPath: 'Bar' })], { complete: true }, db);
    await applySnapshot('chrome', [chrome('1', 'https://a.dev/', { folderPath: 'Bar / Moved', title: 'Renamed' })], { complete: true }, db);
    expect(await db.items.toArray()).toMatchObject([{ title: 'Renamed', folderPaths: ['Bar / Moved'] }]);
  });
});

describe('removeSaves', () => {
  it('marks only the named saves removed', async () => {
    await applySnapshot('x', [
      { source: 'x', sourceId: '1', url: 'https://x.com/a/status/1' },
      { source: 'x', sourceId: '2', url: 'https://x.com/a/status/2' },
    ], { complete: false }, db);
    expect(await removeSaves('x', ['2', 'missing'], db)).toBe(1);
    expect((await db.items.toArray()).map((i) => i.removed)).toEqual([false, true]);
  });
});
