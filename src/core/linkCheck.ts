import { isWebUrl } from './canonical';
import { db as defaultDb, type BookmarkieDB } from './db';
import type { Item, LinkCheck, LinkStatus } from './types';

export const LINK_CHECK_TTL = 30 * 86_400_000;
const TIMEOUT_MS = 10_000;

/** Only "gone" answers count as dead. Anything that might be a block or a blip is "unsure". */
export function classifyStatus(code: number): LinkStatus {
  if (code === 404 || code === 410) return 'dead';
  if (code >= 200 && code < 400) return 'ok';
  return 'unsure';
}

type Fetch = typeof fetch;

async function request(url: string, method: 'HEAD' | 'GET', fetchImpl: Fetch, timeoutMs: number) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method,
      credentials: 'omit',
      redirect: 'follow',
      cache: 'no-store',
      signal: ctrl.signal,
    });
    // Don't download page bodies; the status is all we need.
    if (method === 'GET') void res.body?.cancel().catch(() => undefined);
    return { code: res.status };
  } catch (err) {
    return { error: ctrl.signal.aborted ? ('timeout' as const) : ('network' as const), detail: err };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkUrl(
  url: string,
  fetchImpl: Fetch = fetch,
  timeoutMs = TIMEOUT_MS,
): Promise<Omit<LinkCheck, 'checkedAt'>> {
  let res = await request(url, 'HEAD', fetchImpl, timeoutMs);
  // Many servers reject HEAD; ask again the normal way before judging.
  if ('code' in res && res.code !== undefined && [403, 404, 405, 501].includes(res.code)) {
    res = await request(url, 'GET', fetchImpl, timeoutMs);
  }
  if ('error' in res) {
    if (res.error === 'timeout') return { status: 'unsure' };
    // A site that can't be reached twice in a row is gone (or its domain expired).
    const again = await request(url, 'GET', fetchImpl, timeoutMs);
    if ('code' in again && again.code !== undefined) return { status: classifyStatus(again.code), code: again.code };
    return { status: again.error === 'timeout' ? 'unsure' : 'dead' };
  }
  return { status: classifyStatus(res.code), code: res.code };
}

export function needsCheck(item: Item, now = Date.now()): boolean {
  if (item.removed || !isWebUrl(item.url)) return false;
  if (!item.sources.some((s) => s === 'chrome' || s === 'readinglist')) return false;
  return !item.linkCheck || now - item.linkCheck.checkedAt > LINK_CHECK_TTL;
}

export interface LinkCheckProgress {
  done: number;
  total: number;
  dead: number;
  unsure: number;
  /** Set when most early checks fail to connect, which usually means the computer is offline. */
  looksOffline?: boolean;
}

export async function runLinkCheck(
  items: Item[],
  opts: {
    concurrency?: number;
    signal?: AbortSignal;
    onProgress?: (p: LinkCheckProgress) => void;
    fetchImpl?: Fetch;
    database?: BookmarkieDB;
    now?: () => number;
  } = {},
): Promise<LinkCheckProgress> {
  const { concurrency = 6, signal, onProgress, fetchImpl = fetch, database = defaultDb, now = Date.now } = opts;
  const queue = items.filter((i) => needsCheck(i, now()));
  const progress: LinkCheckProgress = { done: 0, total: queue.length, dead: 0, unsure: 0 };
  // Offline looks exactly like every site vanishing, so the first results are held back
  // until enough of them show the network is fine.
  const probeSize = Math.min(20, queue.length);
  const held: [number, LinkCheck][] = [];
  let unreachable = 0;
  let next = 0;

  const save = (id: number, check: LinkCheck) => database.items.update(id, { linkCheck: check });

  const worker = async () => {
    while (next < queue.length && !signal?.aborted && !progress.looksOffline) {
      const item = queue[next++]!;
      const result = await checkUrl(item.url, fetchImpl);
      if (signal?.aborted || progress.looksOffline) return;
      const check: LinkCheck = { ...result, checkedAt: now() };
      progress.done++;
      if (result.status === 'dead') progress.dead++;
      if (result.status === 'unsure') progress.unsure++;

      if (progress.done <= probeSize) {
        if (result.status === 'dead' && result.code === undefined) unreachable++;
        held.push([item.id!, check]);
        if (progress.done === probeSize) {
          if (probeSize >= 5 && unreachable / probeSize > 0.8) {
            progress.looksOffline = true;
            onProgress?.({ ...progress });
            return;
          }
          await Promise.all(held.map(([id, c]) => save(id, c)));
        }
      } else {
        await save(item.id!, check);
      }
      onProgress?.({ ...progress });
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return progress;
}
