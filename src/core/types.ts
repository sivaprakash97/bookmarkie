export const SOURCES = ['chrome', 'readinglist', 'x', 'linkedin', 'instagram'] as const;
export type Source = (typeof SOURCES)[number];

export const SOURCE_LABELS: Record<Source, string> = {
  chrome: 'Chrome',
  readinglist: 'Reading list',
  x: 'X',
  linkedin: 'LinkedIn',
  instagram: 'Instagram',
};

export type Kind = 'page' | 'post' | 'reel' | 'video' | 'image';

export type EnrichStatus = 'pending' | 'done' | 'skipped' | 'failed' | 'none';

/** One save of a link on one platform. A link can be saved in several places. */
export interface Save {
  id?: number;
  source: Source;
  /** The platform's own id for the save (Chrome bookmark id, tweet id, ...). */
  sourceId: string;
  itemId: number;
  url: string;
  title?: string;
  author?: string;
  text?: string;
  folderPath?: string;
  savedAt: number;
  lastSeenAt: number;
  /** Set when the save disappears from the platform. Rows are never hard-deleted. */
  removedAt?: number;
}

export interface SaveRef {
  source: Source;
  savedAt: number;
  removed: boolean;
}

/** One row per canonical URL, with fields denormalized from its saves for search. */
export interface Item {
  id?: number;
  canonicalUrl: string;
  url: string;
  title: string;
  kind: Kind;
  siteName: string;
  author?: string;
  text?: string;
  /** Sources with at least one active (not removed) save. Indexed. */
  sources: Source[];
  saveRefs: SaveRef[];
  folderPaths: string[];
  firstSavedAt: number;
  lastSavedAt: number;
  /** True when every save of this link was removed on its platform. */
  removed: boolean;
  // Filled by enrichment (milestone 3). Present now so the index shape is stable.
  tags: string[];
  colorBuckets: string[];
  summary?: string;
  searchPhrases?: string[];
  enrich: { status: EnrichStatus; attempts: number };
}

export type SourceStatus = 'ok' | 'stale' | 'broken' | 'needs-login' | 'paused' | 'off';

export interface SourceState {
  source: Source;
  status: SourceStatus;
  lastSyncAt?: number;
  activeCount?: number;
  lastError?: string;
}

/** What a capture path hands to ingest. */
export interface SaveInput {
  source: Source;
  sourceId: string;
  url: string;
  title?: string;
  author?: string;
  text?: string;
  folderPath?: string;
  savedAt?: number;
}
