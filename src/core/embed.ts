import { db as defaultDb, type BookmarkieDB } from './db';
import type { Item } from './types';

export const EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';

/** Turns texts into unit-length vectors. The app runs the model in a Web Worker. */
export interface Embedder {
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** What the model sees for a bookmark until pages are read in a later milestone. */
export function itemText(item: Item): string {
  let path = '';
  try {
    const u = new URL(item.url);
    path = decodeURIComponent(u.pathname).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  } catch {
    // Non-web URL: the title is enough.
  }
  return [item.title, item.siteName, path, item.folderPaths.join(', ')].filter(Boolean).join(' · ').slice(0, 512);
}

/** FNV-1a; only used to notice when a bookmark's text changed. */
export function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * Returns a vector for every item, embedding only those that are new or changed
 * since last time. Progress counts items embedded in this run.
 */
export async function ensureVectors(
  items: Item[],
  embedder: Embedder,
  opts: { batchSize?: number; onProgress?: (done: number, total: number) => void; signal?: AbortSignal; database?: BookmarkieDB } = {},
): Promise<Map<number, Float32Array>> {
  const { batchSize = 32, onProgress, signal, database = defaultDb } = opts;
  const ids = items.map((i) => i.id!);
  const cached = await database.vectors.bulkGet(ids);
  const out = new Map<number, Float32Array>();
  const todo: { item: Item; text: string; hash: string }[] = [];

  items.forEach((item, i) => {
    const text = itemText(item);
    const hash = hashText(text);
    const row = cached[i];
    if (row && row.model === EMBED_MODEL && row.textHash === hash) out.set(item.id!, row.vec);
    else todo.push({ item, text, hash });
  });

  for (let start = 0; start < todo.length; start += batchSize) {
    if (signal?.aborted) break;
    const batch = todo.slice(start, start + batchSize);
    const vecs = await embedder.embed(batch.map((b) => b.text));
    await database.vectors.bulkPut(
      batch.map((b, j) => ({ itemId: b.item.id!, model: EMBED_MODEL, textHash: b.hash, vec: vecs[j]! })),
    );
    batch.forEach((b, j) => out.set(b.item.id!, vecs[j]!));
    onProgress?.(Math.min(start + batchSize, todo.length), todo.length);
  }
  return out;
}
