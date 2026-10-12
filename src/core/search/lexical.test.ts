import { describe, expect, it } from 'vitest';
import { deriveItem } from '../ingest';
import { parseQuery } from '../queryParse';
import type { Item, Save, Source } from '../types';
import { LexicalIndex } from './lexical';

const NOW = new Date(2026, 9, 12, 12).getTime();
let nextId = 1;

function item(title: string, url: string, opts: { source?: Source; savedAt?: number; folder?: string; removed?: boolean; colors?: string[] } = {}): Item {
  const id = nextId++;
  const save: Save = {
    source: opts.source ?? 'chrome', sourceId: String(id), itemId: id, url, title,
    folderPath: opts.folder, savedAt: opts.savedAt ?? NOW - 86_400_000, lastSeenAt: NOW,
    removedAt: opts.removed ? NOW : undefined,
  };
  const base: Item = {
    id, canonicalUrl: url, url, title: '', kind: 'page', siteName: new URL(url).hostname.replace(/^www\./, ''),
    sources: [], saveRefs: [], folderPaths: [], firstSavedAt: 0, lastSavedAt: 0, removed: false,
    tags: [], colorBuckets: opts.colors ?? [], enrich: { status: 'pending', attempts: 0 },
  };
  return deriveItem(base, [save]);
}

const library = [
  item('A Complete Guide to React Hooks', 'https://overreacted.io/a-complete-guide-to-useeffect/', { folder: 'Bookmarks bar / Dev / React' }),
  item('SaaS pricing page teardown', 'https://www.linkedin.com/feed/update/urn:li:activity:1', { source: 'linkedin', savedAt: new Date(2026, 3, 10).getTime() }),
  item('Pricing strategy for developer tools', 'https://example.com/pricing-devtools', { savedAt: new Date(2025, 1, 1).getTime() }),
  item('Blue Bottle Coffee', 'https://bluebottlecoffee.com/'),
  item('Brand colour palettes', 'https://palettes.dev/', { colors: ['blue', 'white'] }),
  item('Old removed recipe', 'https://recipes.example/soup', { removed: true }),
  item('Thread on Rust async', 'https://x.com/i/status/99', { source: 'x' }),
];
const index = new LexicalIndex(library);
const titles = (q: string, opts = {}) => index.search(parseQuery(q, NOW), opts).map((h) => h.item.title);

describe('LexicalIndex', () => {
  it('ranks title matches first and tolerates typos and prefixes', () => {
    expect(titles('react hooks')[0]).toBe('A Complete Guide to React Hooks');
    expect(titles('reakt hoks')[0]).toBe('A Complete Guide to React Hooks');
    expect(titles('prici')).toEqual(expect.arrayContaining(['SaaS pricing page teardown', 'Pricing strategy for developer tools']));
  });

  it('matches folder names and site names', () => {
    expect(titles('dev react')[0]).toBe('A Complete Guide to React Hooks');
    expect(titles('overreacted')[0]).toBe('A Complete Guide to React Hooks');
  });

  it('ignores filler words in natural-language queries', () => {
    expect(titles('that article about pricing I saved')[0]).toMatch(/pricing/i);
  });

  it('applies source and date filters from the query', () => {
    expect(titles('pricing from linkedin')).toEqual(['SaaS pricing page teardown']);
    expect(titles('pricing last spring')).toEqual(['SaaS pricing page teardown']);
    expect(titles('pricing in 2025')).toEqual(['Pricing strategy for developer tools']);
    expect(titles('tweets')).toEqual(['Thread on Rust async']);
  });

  it('lists newest first when only filters are given', () => {
    expect(titles('')[0]).not.toBe('Old removed recipe');
    expect(titles('from linkedin')).toEqual(['SaaS pricing page teardown']);
  });

  it('hides removed items unless asked', () => {
    expect(titles('recipe')).toEqual([]);
    expect(titles('recipe', { includeRemoved: true })).toEqual(['Old removed recipe']);
  });

  it('respects the UI source facet', () => {
    expect(titles('pricing', { sources: ['chrome'] })).toEqual(['Pricing strategy for developer tools']);
  });

  it('boosts color matches without filtering everything else out', () => {
    const blue = titles('blue');
    expect(blue[0]).toBe('Brand colour palettes');
    expect(blue).toContain('Blue Bottle Coffee');
  });

  it('ranks full matches above partial ones', () => {
    const r = titles('pricing teardown');
    expect(r[0]).toBe('SaaS pricing page teardown');
    expect(r).toContain('Pricing strategy for developer tools');
  });
});
