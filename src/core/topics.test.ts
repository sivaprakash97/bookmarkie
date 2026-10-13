import { describe, expect, it } from 'vitest';
import { deriveItem } from './ingest';
import { ensureVectors, hashText, itemText, type Embedder } from './embed';
import { BookmarkieDB } from './db';
import { cutoffFor, scoreTopics, topicPhrases } from './topics';
import type { Item } from './types';

/** Fake model: one dimension per keyword, so similarity is predictable. */
const KEYWORDS = ['design', 'font', 'color', 'recipe', 'cricket', 'exam'];
const fakeEmbedder = (): Embedder & { calls: number } => {
  const e = {
    calls: 0,
    async embed(texts: string[]) {
      e.calls += texts.length;
      return texts.map((t) => {
        const v = new Float32Array(KEYWORDS.length + 1);
        KEYWORDS.forEach((k, i) => (v[i] = t.toLowerCase().includes(k) ? 1 : 0));
        v[KEYWORDS.length] = 0.1;
        return v;
      });
    },
  };
  return e;
};

let nextId = 1;
function item(title: string, url: string, folder?: string): Item {
  const id = nextId++;
  return deriveItem(
    { id, canonicalUrl: url, url, title: '', kind: 'page', siteName: '', sources: [], saveRefs: [], folderPaths: [],
      firstSavedAt: 0, lastSavedAt: 0, removed: false, tags: [], colorBuckets: [], enrich: { status: 'pending', attempts: 0 } },
    [{ source: 'chrome', sourceId: String(id), itemId: id, url, title, folderPath: folder, savedAt: 1, lastSeenAt: 1 }],
  );
}

describe('topicPhrases', () => {
  it('expands design topics but leaves others alone', () => {
    expect(topicPhrases(['design']).length).toBeGreaterThan(5);
    expect(topicPhrases(['cooking', ' '])).toEqual(['cooking']);
  });
});

describe('scoreTopics', () => {
  it('ranks unrelated bookmarks first and keeps design sites and folders by rule', async () => {
    const items = [
      item('Best design tools', 'https://tools.example/'),
      item('Pasta recipe', 'https://food.example/pasta'),
      item('Untitled shot', 'https://dribbble.com/shots/1'),
      item('Cricket scores', 'https://cricbuzz.com/'),
      item('Random page', 'https://random.example/', 'Bookmarks bar / UI Inspiration'),
    ];
    const embedder = fakeEmbedder();
    const db = new BookmarkieDB('topics-1');
    const vectors = await ensureVectors(items, embedder, { database: db });
    const scores = await scoreTopics(items, vectors, ['design', 'typography'], embedder);
    const unrelated = scores.filter((s) => s.score < cutoffFor(50)).map((s) => s.item.title);
    expect(unrelated.sort()).toEqual(['Cricket scores', 'Pasta recipe']);
    expect(scores.find((s) => s.item.title === 'Untitled shot')?.rule).toMatch(/dribbble\.com/);
    expect(scores.find((s) => s.item.title === 'Random page')?.rule).toMatch(/UI Inspiration/);
  });
});

describe('ensureVectors', () => {
  it('only embeds new or changed bookmarks', async () => {
    const db = new BookmarkieDB('topics-2');
    const embedder = fakeEmbedder();
    const a = item('Design systems', 'https://a.example/');
    const b = item('Recipe box', 'https://b.example/');
    await ensureVectors([a, b], embedder, { database: db });
    expect(embedder.calls).toBe(2);
    await ensureVectors([a, b], embedder, { database: db });
    expect(embedder.calls).toBe(2);
    await ensureVectors([a, { ...b, title: 'Recipe box (renamed)' }], embedder, { database: db });
    expect(embedder.calls).toBe(3);
  });

  it('builds the text from title, site, path and folder', () => {
    const i = item('Grid systems', 'https://example.com/articles/grid-layout', 'Design / Layout');
    expect(itemText(i)).toBe('Grid systems · example.com · articles grid layout · Design / Layout');
    expect(hashText('a')).not.toBe(hashText('b'));
  });
});
