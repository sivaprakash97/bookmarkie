import { beforeEach, describe, expect, it } from 'vitest';
import { BookmarkieDB } from './db';
import { applySnapshot } from './ingest';
import { checkUrl, classifyStatus, runLinkCheck } from './linkCheck';

type Answer = number | 'network' | 'timeout';

/** A fake fetch where each URL answers from a script, one entry per request. */
function fakeFetch(script: Record<string, Answer[]>) {
  const calls: string[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method} ${url}`);
    const answer = script[url]?.shift() ?? script[url + '*']?.[0] ?? 200;
    if (answer === 'network') throw new TypeError('Failed to fetch');
    if (answer === 'timeout') {
      await new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    }
    return new Response(null, { status: answer as number });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('classifyStatus', () => {
  it('only treats "gone" answers as dead', () => {
    expect(classifyStatus(200)).toBe('ok');
    expect(classifyStatus(301)).toBe('ok');
    expect(classifyStatus(404)).toBe('dead');
    expect(classifyStatus(410)).toBe('dead');
    for (const code of [401, 403, 429, 500, 503]) expect(classifyStatus(code)).toBe('unsure');
  });
});

describe('checkUrl', () => {
  it('uses HEAD and accepts a 200', async () => {
    const { impl, calls } = fakeFetch({ 'https://a.dev': [200] });
    expect(await checkUrl('https://a.dev', impl)).toEqual({ status: 'ok', code: 200 });
    expect(calls).toEqual(['HEAD https://a.dev']);
  });

  it('retries with GET when HEAD is refused, and believes the GET', async () => {
    const { impl, calls } = fakeFetch({ 'https://a.dev': [405, 200] });
    expect(await checkUrl('https://a.dev', impl)).toEqual({ status: 'ok', code: 200 });
    expect(calls).toEqual(['HEAD https://a.dev', 'GET https://a.dev']);
  });

  it('confirms a 404 with GET before calling it dead', async () => {
    expect(await checkUrl('https://a.dev', fakeFetch({ 'https://a.dev': [404, 404] }).impl)).toEqual({ status: 'dead', code: 404 });
    expect(await checkUrl('https://b.dev', fakeFetch({ 'https://b.dev': [404, 200] }).impl)).toEqual({ status: 'ok', code: 200 });
  });

  it('calls unreachable sites dead only after a second try', async () => {
    expect(await checkUrl('https://gone.invalid', fakeFetch({ 'https://gone.invalid': ['network', 'network'] }).impl)).toEqual({ status: 'dead' });
    expect(await checkUrl('https://flaky.dev', fakeFetch({ 'https://flaky.dev': ['network', 200] }).impl)).toEqual({ status: 'ok', code: 200 });
  });

  it('treats blocks and timeouts as unsure', async () => {
    expect(await checkUrl('https://a.dev', fakeFetch({ 'https://a.dev': [403, 403] }).impl)).toEqual({ status: 'unsure', code: 403 });
    expect(await checkUrl('https://a.dev', fakeFetch({ 'https://a.dev': [429] }).impl)).toEqual({ status: 'unsure', code: 429 });
    expect(await checkUrl('https://slow.dev', fakeFetch({ 'https://slow.dev': ['timeout'] }).impl, 20)).toEqual({ status: 'unsure' });
  });
});

describe('runLinkCheck', () => {
  let db: BookmarkieDB;
  let n = 0;
  beforeEach(() => {
    db = new BookmarkieDB(`linkcheck-${n++}`);
  });

  const seed = async (urls: string[]) => {
    await applySnapshot('chrome', urls.map((url, i) => ({ source: 'chrome', sourceId: String(i), url })), { complete: true }, db);
    return db.items.toArray();
  };

  it('stores results and skips fresh ones next time', async () => {
    const items = await seed(['https://ok.dev/', 'https://gone.dev/', 'javascript:void(0)']);
    const { impl, calls } = fakeFetch({ 'https://ok.dev/': [200], 'https://gone.dev/': [404, 404] });
    const result = await runLinkCheck(items, { fetchImpl: impl, database: db });
    expect(result).toMatchObject({ done: 2, total: 2, dead: 1 });
    const byUrl = Object.fromEntries((await db.items.toArray()).map((i) => [i.url, i.linkCheck?.status]));
    expect(byUrl).toEqual({ 'https://ok.dev/': 'ok', 'https://gone.dev/': 'dead', 'javascript:void(0)': undefined });

    calls.length = 0;
    await runLinkCheck(await db.items.toArray(), { fetchImpl: impl, database: db });
    expect(calls).toEqual([]);
  });

  it('stops and saves nothing when it looks offline', async () => {
    const urls = Array.from({ length: 25 }, (_, i) => `https://site${i}.dev/`);
    const items = await seed(urls);
    const script = Object.fromEntries(urls.map((u) => [u + '*', ['network' as const]]));
    const result = await runLinkCheck(items, { fetchImpl: fakeFetch(script).impl, database: db });
    expect(result.looksOffline).toBe(true);
    expect((await db.items.toArray()).filter((i) => i.linkCheck)).toHaveLength(0);
  });
});
