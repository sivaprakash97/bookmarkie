import MiniSearch from 'minisearch';
import type { ParsedQuery } from '../queryParse';
import type { Item, Source } from '../types';

export interface SearchOptions {
  includeRemoved?: boolean;
  /** Source facet picked in the UI; intersected with sources named in the query. */
  sources?: Source[];
  limit?: number;
}

export interface Hit {
  item: Item;
  score: number;
  terms: string[];
}

// Dropped from queries only, so "that article about pricing I saved" becomes "article pricing".
const QUERY_STOPWORDS = new Set(
  ('a an and are about as at be bookmark bookmarked bookmarks by find for from had have i in is it ' +
    'link me my of on one or post saved some something that the thing this to was what where which ' +
    'with').split(' '),
);

interface Doc {
  id: number;
  title: string;
  site: string;
  urlText: string;
  folders: string;
  tags: string;
  phrases: string;
  summary: string;
  author: string;
  text: string;
}

function urlWords(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname} ${decodeURIComponent(u.pathname)} ${decodeURIComponent(u.search)}`
      .replace(/[^\p{L}\p{N}]+/gu, ' ');
  } catch {
    return url;
  }
}

function toDoc(item: Item): Doc {
  return {
    id: item.id!,
    title: item.title,
    site: item.siteName.replace(/\.(com|org|net|io|dev|co|app)$/, ''),
    urlText: urlWords(item.url),
    folders: item.folderPaths.join(' '),
    tags: item.tags.join(' '),
    phrases: (item.searchPhrases ?? []).join(' '),
    summary: item.summary ?? '',
    author: item.author ?? '',
    text: (item.text ?? '').slice(0, 8000),
  };
}

const FIELDS: (keyof Doc)[] = ['title', 'site', 'urlText', 'folders', 'tags', 'phrases', 'summary', 'author', 'text'];
const BOOST: Partial<Record<keyof Doc, number>> = {
  title: 4, tags: 2.5, phrases: 2.5, site: 2, folders: 1.5, author: 1.5, summary: 1.2, urlText: 1, text: 0.6,
};

export class LexicalIndex {
  private ms: MiniSearch<Doc>;
  private items = new Map<number, Item>();

  constructor(items: Item[] = []) {
    this.ms = new MiniSearch<Doc>({ fields: FIELDS, idField: 'id' });
    this.addAll(items);
  }

  get size(): number {
    return this.items.size;
  }

  addAll(items: Item[]): void {
    const docs: Doc[] = [];
    for (const item of items) {
      if (item.id === undefined) continue;
      if (this.items.has(item.id)) this.ms.discard(item.id);
      this.items.set(item.id, item);
      docs.push(toDoc(item));
    }
    this.ms.addAll(docs);
  }

  search(parsed: ParsedQuery, opts: SearchOptions = {}): Hit[] {
    const limit = opts.limit ?? 200;
    const sources = intersect(parsed.sources, opts.sources);
    const accept = (item: Item) => passesFilters(item, parsed, sources, !!opts.includeRemoved);

    const colorWords = new Set(
      parsed.chips.filter((c) => c.type === 'color').map((c) => c.raw.toLowerCase()),
    );
    const terms = (MiniSearch.getDefault('tokenize') as (s: string) => string[])(parsed.text)
      .map((t) => t.toLowerCase())
      .filter((t) => t && !QUERY_STOPWORDS.has(t) && !colorWords.has(t));

    let hits: Hit[];
    if (!terms.length) {
      // Filters only ("linkedin last month") or empty query: newest first.
      hits = [...this.items.values()]
        .filter(accept)
        .map((item) => ({ item, score: 0, terms: [] }))
        .sort((a, b) => b.item.lastSavedAt - a.item.lastSavedAt);
    } else {
      hits = this.textSearch(terms, accept);
    }

    if (parsed.colors.length) hits = boostColors(hits, parsed.colors, colorWords);
    return hits.slice(0, limit);
  }

  private textSearch(terms: string[], accept: (item: Item) => boolean): Hit[] {
    const filter = (r: { id: number }) => {
      const item = this.items.get(r.id);
      return !!item && accept(item);
    };
    const common = {
      boost: BOOST as Record<string, number>,
      prefix: (term: string) => term.length >= 3,
      fuzzy: (term: string) => (term.length >= 5 ? 0.2 : term.length >= 4 ? 1 : 0),
      filter,
    };
    const query = terms.join(' ');
    // Every term must match first; then fill with partial matches ranked below.
    const all = this.ms.search(query, { ...common, combineWith: 'AND' });
    const seen = new Set(all.map((r) => r.id as number));
    const some = terms.length > 1
      ? this.ms.search(query, { ...common, combineWith: 'OR' }).filter((r) => !seen.has(r.id as number))
      : [];
    const top = all[0]?.score ?? 1;

    return [
      ...all.map((r) => ({ id: r.id as number, score: r.score, terms: r.terms })),
      // Partial matches never outrank full ones.
      ...some.map((r) => ({ id: r.id as number, score: Math.min(r.score * 0.5, top * 0.49), terms: r.terms })),
    ].map(({ id, score, terms: t }) => ({ item: this.items.get(id)!, score, terms: t }));
  }
}

function intersect(a?: Source[], b?: Source[]): Source[] | undefined {
  if (!a?.length) return b?.length ? b : undefined;
  if (!b?.length) return a;
  return a.filter((s) => b.includes(s));
}

export function passesFilters(
  item: Item,
  parsed: Pick<ParsedQuery, 'dateRange'>,
  sources: Source[] | undefined,
  includeRemoved: boolean,
): boolean {
  if (item.removed && !includeRemoved) return false;
  let refs = includeRemoved ? item.saveRefs : item.saveRefs.filter((r) => !r.removed);
  if (sources) refs = refs.filter((r) => sources.includes(r.source));
  const range = parsed.dateRange;
  if (range) {
    refs = refs.filter(
      (r) => (range.from === undefined || r.savedAt >= range.from) && (range.to === undefined || r.savedAt < range.to),
    );
  }
  return refs.length > 0;
}

/** Colors are a soft signal: matching items move up, nothing is filtered out. */
function boostColors(hits: Hit[], colors: string[], colorWords: Set<string>): Hit[] {
  const boosted = hits.map((h) => {
    const bucketMatch = h.item.colorBuckets.some((b) => colors.includes(b));
    const title = h.item.title.toLowerCase();
    const wordMatch = [...colorWords].some((w) => title.includes(w));
    const factor = bucketMatch ? 1.6 : wordMatch ? 1.3 : 1;
    return { hit: h, factor };
  });
  if (boosted.every((b) => b.factor === 1)) return hits;
  return boosted
    .map(({ hit, factor }) => ({ ...hit, score: (hit.score || 1) * factor }))
    .sort((a, b) => b.score - a.score || b.item.lastSavedAt - a.item.lastSavedAt);
}
