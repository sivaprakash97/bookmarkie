import { cosine, type Embedder } from './embed';
import type { Item } from './types';

export const DEFAULT_TOPICS = ['design', 'UI/UX', 'typography', 'branding', 'illustration'];

const DESIGN_TOPIC = /design|\bui\b|\bux\b|typograph|font|brand|illustrat|logo|icon|figma|graphic|visual|colou?r|layout|prototyp/i;

/** Extra phrasings so a short topic like "design" catches the many ways design shows up. */
const DESIGN_EXPANSIONS = [
  'graphic design', 'web design inspiration', 'product design case study', 'user interface design',
  // Kept specific: generic words like "tutorial" or "portfolio" pull in unrelated pages.
  'user experience research', 'design system components', 'figma', 'color palette',
  'icon set', 'logo design', 'font and typeface', 'landing page design', 'mobile app UI', 'design portfolio',
];

/** Sites that are about design whatever the page title says. */
export const DESIGN_DOMAINS = [
  'dribbble.com', 'behance.net', 'figma.com', 'awwwards.com', 'mobbin.com', 'uxdesign.cc', 'nngroup.com',
  'smashingmagazine.com', 'fonts.google.com', 'coolors.co', 'colorhunt.co', 'designsystems.com',
  'land-book.com', 'lapa.ninja', 'onepagelove.com', 'siteinspire.com', 'godly.website',
  'creativebloq.com', 'itsnicethat.com', 'designmodo.com', 'uxplanet.org', 'uxcollective.com',
  'fontsinuse.com', 'typewolf.com', 'muz.li', 'canva.com', 'framer.com', 'webflow.com',
  'sketch.com', 'invisionapp.com', 'abduzeedo.com', 'brandnew.underconsideration.com', 'fontshare.com',
  'unsplash.com', 'pexels.com', 'iconify.design', 'thenounproject.com', 'refactoringui.com', 'lawsofux.com',
];

export function topicPhrases(topics: string[]): string[] {
  const clean = topics.map((t) => t.trim()).filter(Boolean);
  return clean.some((t) => DESIGN_TOPIC.test(t)) ? [...new Set([...clean, ...DESIGN_EXPANSIONS])] : clean;
}

export interface TopicScore {
  item: Item;
  /** 0 = clearly unrelated, 1 = clearly on-topic. */
  score: number;
  /** Why it counts as on-topic regardless of the model, if a rule matched. */
  rule?: string;
}

function ruleMatch(item: Item, topics: string[]): string | undefined {
  const designish = topics.some((t) => DESIGN_TOPIC.test(t));
  const site = item.siteName;
  if (designish && DESIGN_DOMAINS.some((d) => site === d || site.endsWith('.' + d))) return `Design site (${site})`;
  const words = topics.map((t) => t.toLowerCase());
  const folder = item.folderPaths.find((f) => {
    const lower = f.toLowerCase();
    return words.some((w) => lower.includes(w)) || (designish && DESIGN_TOPIC.test(f));
  });
  return folder ? `In folder "${folder}"` : undefined;
}

/**
 * Scores how related each bookmark is to the topics, least related first.
 * The score is the best cosine match against any topic phrase; rules force a 1.
 */
export async function scoreTopics(
  items: Item[],
  vectors: Map<number, Float32Array>,
  topics: string[],
  embedder: Embedder,
): Promise<TopicScore[]> {
  const phrases = topicPhrases(topics);
  if (!phrases.length) return [];
  const topicVecs = await embedder.embed(phrases);
  return items
    .map((item) => {
      const rule = ruleMatch(item, topics);
      if (rule) return { item, score: 1, rule };
      const vec = vectors.get(item.id!);
      const score = vec ? Math.max(...topicVecs.map((t) => cosine(vec, t))) : 1;
      return { item, score };
    })
    .sort((a, b) => a.score - b.score);
}

/**
 * Strictness 0–100 maps to a similarity cut-off; bookmarks scoring below it are
 * listed as unrelated. Calibrated on all-MiniLM-L6-v2 with design topics:
 * unrelated titles (recipes, sports, email, coding) scored 0.13–0.28 and design
 * titles 0.32–0.82, so the default (50) cuts at about 0.27.
 */
export function cutoffFor(strictness: number): number {
  return 0.18 + (Math.max(0, Math.min(100, strictness)) / 100) * 0.17;
}

export const DEFAULT_STRICTNESS = 50;
