import { browser } from 'wxt/browser';
import { flattenBookmarkTree, readingListToInputs, type BookmarkNode, type ReadingListEntry } from './chromeSource';
import { db } from './db';
import { applySnapshot, type IngestResult } from './ingest';
import type { Source } from './types';

type ChromeLike = typeof browser;

/** Serializes syncs so two reconciles never interleave. */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

async function recordState(source: Source, error?: unknown): Promise<void> {
  const activeCount = await db.saves
    .where('source')
    .equals(source)
    .filter((s) => !s.removedAt)
    .count();
  await db.sourceState.put({
    source,
    status: error ? 'broken' : 'ok',
    lastSyncAt: Date.now(),
    activeCount,
    lastError: error ? String(error instanceof Error ? error.message : error) : undefined,
  });
}

export function syncChromeBookmarks(api: ChromeLike = browser): Promise<IngestResult | null> {
  return serial(async () => {
    try {
      const tree = (await api.bookmarks.getTree()) as BookmarkNode[];
      const result = await applySnapshot('chrome', flattenBookmarkTree(tree), { complete: true });
      await recordState('chrome');
      return result;
    } catch (err) {
      await recordState('chrome', err);
      console.error('[bookmarkie] chrome sync failed', err);
      return null;
    }
  });
}

export function syncReadingList(api: ChromeLike = browser): Promise<IngestResult | null> {
  return serial(async () => {
    // browser.readingList exists from Chrome 120.
    if (!api.readingList) return null;
    try {
      const entries = (await api.readingList.query({})) as ReadingListEntry[];
      const result = await applySnapshot('readinglist', readingListToInputs(entries), { complete: true });
      await recordState('readinglist');
      return result;
    } catch (err) {
      await recordState('readinglist', err);
      console.error('[bookmarkie] reading list sync failed', err);
      return null;
    }
  });
}
