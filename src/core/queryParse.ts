import * as chrono from 'chrono-node';
import type { Source } from './types';

export interface DateRange {
  from?: number;
  to?: number;
}

export interface Chip {
  type: 'source' | 'date' | 'color';
  label: string;
  /** The exact text in the query that produced this chip, so the UI can remove it. */
  raw: string;
}

export interface ParsedQuery {
  /** What's left for keyword search after filters are pulled out. */
  text: string;
  sources?: Source[];
  dateRange?: DateRange;
  colors: string[];
  chips: Chip[];
}

const DAY = 86_400_000;

const SOURCE_PREP = '\\b(?:on|from|in|via)\\s+';
const sourceRe = (words: string, needsPrep = '') =>
  new RegExp(`(?:${SOURCE_PREP})?\\b(?:${words})\\b${needsPrep && `|${SOURCE_PREP}(?:${needsPrep})\\b`}`, 'i');

const SOURCE_PATTERNS: [RegExp, Source[], string][] = [
  // Bare "x"/"ig" are too ambiguous; only count them after a preposition.
  [sourceRe('twitter|tweets?', 'x'), ['x'], 'X'],
  [sourceRe('linked\\s?in'), ['linkedin'], 'LinkedIn'],
  [sourceRe('instagram|insta', 'ig'), ['instagram'], 'Instagram'],
  [sourceRe('reading\\s?list'), ['readinglist'], 'Reading list'],
  [sourceRe('chrome(?:\\s+bookmarks?)?'), ['chrome', 'readinglist'], 'Chrome'],
];

const COLOR_WORDS: Record<string, string[]> = {
  red: ['red'], crimson: ['red'], scarlet: ['red'], maroon: ['red', 'brown'],
  orange: ['orange'], yellow: ['yellow'], gold: ['yellow'], golden: ['yellow'],
  green: ['green'], lime: ['green'], olive: ['green'], teal: ['teal'],
  turquoise: ['teal'], cyan: ['teal'], aqua: ['teal'], blue: ['blue'], navy: ['blue'],
  purple: ['purple'], violet: ['purple'], lavender: ['purple'], pink: ['pink'],
  magenta: ['pink'], brown: ['brown'], beige: ['brown', 'white'], tan: ['brown'],
  black: ['black'], dark: ['black'], white: ['white'], gray: ['gray'], grey: ['gray'],
};
const COLOR_RE = new RegExp(`\\b(${Object.keys(COLOR_WORDS).join('|')})(?:ish)?\\b`, 'gi');

const NUM_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, couple: 2, few: 3,
};
const NUM = `(\\d+|${Object.keys(NUM_WORDS).join('|')})`;
const UNIT = '(day|week|month|year)s?';
const PREP = '(?:(?:saved|bookmarked)\\s+)?(?:in|on|from|during|around|over|within)?\\s*(?:the\\s+)?';

const SEASONS: Record<string, [number, number]> = {
  // [start month, length in months], northern hemisphere
  spring: [2, 3], summer: [5, 3], fall: [8, 3], autumn: [8, 3], winter: [11, 3],
};

function toNum(s: string): number {
  return NUM_WORDS[s.toLowerCase()] ?? parseInt(s, 10);
}

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function addUnits(t: number, unit: string, n: number): number {
  const d = new Date(t);
  if (unit === 'day') d.setDate(d.getDate() + n);
  else if (unit === 'week') d.setDate(d.getDate() + 7 * n);
  else if (unit === 'month') d.setMonth(d.getMonth() + n);
  else d.setFullYear(d.getFullYear() + n);
  return d.getTime();
}

function startOfUnit(t: number, unit: string): number {
  const d = new Date(startOfDay(t));
  if (unit === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
  if (unit === 'month') d.setDate(1);
  if (unit === 'year') d.setMonth(0, 1);
  return d.getTime();
}

type DateMatcher = (q: string, now: number) => { range: DateRange; raw: string } | null;

const DATE_MATCHERS: DateMatcher[] = [
  // "last spring", "summer 2024", "this winter"
  (q, now) => {
    const m = q.match(new RegExp(`${PREP}\\b(last|this|past)?\\s*(spring|summer|fall|autumn|winter)(?:\\s+(?:of\\s+)?(\\d{4}))?\\b`, 'i'));
    if (!m) return null;
    const [startMonth, len] = SEASONS[m[2]!.toLowerCase()]!;
    const nowD = new Date(now);
    let year = m[3] ? parseInt(m[3], 10) : nowD.getFullYear();
    let from = new Date(year, startMonth, 1).getTime();
    if (!m[3]) {
      // Winter that started in December counts for the following year's Jan/Feb.
      if (startMonth === 11 && nowD.getMonth() < 2) from = new Date(--year, startMonth, 1).getTime();
      const inProgress = from <= now && now < addUnits(from, 'month', len);
      const wantsPrevious = m[1]?.toLowerCase() === 'last' && (inProgress || from > now);
      if (from > now || wantsPrevious) from = addUnits(from, 'year', -1);
    }
    return { range: { from, to: addUnits(from, 'month', len) }, raw: m[0] };
  },
  // "today", "yesterday"
  (q, now) => {
    const m = q.match(new RegExp(`${PREP}\\b(today|yesterday)\\b`, 'i'));
    if (!m) return null;
    const from = startOfDay(now) - (m[1]!.toLowerCase() === 'yesterday' ? DAY : 0);
    return { range: { from, to: from + DAY }, raw: m[0] };
  },
  // "past 3 weeks", "last couple of months"
  (q, now) => {
    const m = q.match(new RegExp(`${PREP}\\b(?:last|past)\\s+${NUM}\\s+(?:of\\s+)?${UNIT}\\b`, 'i'));
    if (!m) return null;
    return { range: { from: addUnits(now, m[2]!.toLowerCase(), -toNum(m[1]!)), to: now }, raw: m[0] };
  },
  // "this week", "last month", "past year"
  (q, now) => {
    const m = q.match(new RegExp(`${PREP}\\b(this|last|past)\\s+(week|month|year)\\b`, 'i'));
    if (!m) return null;
    const unit = m[2]!.toLowerCase();
    const which = m[1]!.toLowerCase();
    if (which === 'past') return { range: { from: addUnits(now, unit, -1), to: now }, raw: m[0] };
    const thisStart = startOfUnit(now, unit);
    const from = which === 'this' ? thisStart : addUnits(thisStart, unit, -1);
    return { range: { from, to: addUnits(from, unit, 1) }, raw: m[0] };
  },
  // "2 weeks ago" → a window of ±1 unit, since memory of dates is fuzzy
  (q, now) => {
    const m = q.match(new RegExp(`${PREP}\\b(?:about\\s+|like\\s+)?${NUM}\\s+(?:of\\s+)?${UNIT}\\s+ago\\b`, 'i'));
    if (!m) return null;
    const unit = m[2]!.toLowerCase();
    const center = addUnits(now, unit, -toNum(m[1]!));
    return { range: { from: addUnits(center, unit, -1), to: Math.min(now, addUnits(center, unit, 1)) }, raw: m[0] };
  },
  // "in 2024", "since 2023", "before 2025"
  (q) => {
    const m = q.match(/\b(in|from|during|since|after|before)\s+((?:19|20)\d{2})\b/i);
    if (!m) return null;
    const y = parseInt(m[2]!, 10);
    const from = new Date(y, 0, 1).getTime();
    const to = new Date(y + 1, 0, 1).getTime();
    const op = m[1]!.toLowerCase();
    const range = op === 'since' || op === 'after' ? { from } : op === 'before' ? { to: from } : { from, to };
    return { range, raw: m[0] };
  },
];

/** Absolute dates via chrono ("in march", "since june 2024", "on 5 may"), always in the past. */
function chronoDate(q: string, now: number): { range: DateRange; raw: string } | null {
  const ref = new Date(now);
  const result = chrono.parse(q, ref)[0];
  if (!result) return null;
  const s = result.start;
  let start = s.date().getTime();
  if (start > now && !s.isCertain('year')) start = addUnits(start, 'year', -1);
  if (start > now + DAY) return null;

  let range: DateRange;
  if (result.end) range = { from: startOfDay(start), to: startOfDay(result.end.date().getTime()) + DAY };
  else if (s.isCertain('day')) range = { from: startOfDay(start), to: startOfDay(start) + DAY };
  else if (s.isCertain('month')) {
    const from = startOfUnit(start, 'month');
    range = { from, to: addUnits(from, 'month', 1) };
  } else return null;

  // Pull in a leading operator/preposition so it's stripped from the text too.
  const before = q.slice(0, result.index);
  const op = before.match(/\b(since|after|before|in|on|from|during|around)\s+$/i);
  const raw = (op ? op[0] : '') + result.text;
  const kind = op?.[1]!.toLowerCase();
  if (kind === 'since' || kind === 'after') range = { from: range.from };
  if (kind === 'before') range = { to: range.from };
  return { range, raw };
}

function formatRange(r: DateRange): string {
  const fmt = (t: number) =>
    new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  if (r.from !== undefined && r.to !== undefined) return `${fmt(r.from)} – ${fmt(r.to - 1)}`;
  if (r.from !== undefined) return `since ${fmt(r.from)}`;
  return `before ${fmt(r.to!)}`;
}

function strip(text: string, raw: string): string {
  return text.replace(raw, ' ');
}

export function parseQuery(query: string, now = Date.now()): ParsedQuery {
  let text = query;
  const chips: Chip[] = [];

  let sources: Source[] | undefined;
  for (const [re, srcs, label] of SOURCE_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    sources = [...new Set([...(sources ?? []), ...srcs])];
    chips.push({ type: 'source', label, raw: m[0] });
    text = strip(text, m[0]);
  }

  let dateRange: DateRange | undefined;
  for (const match of [...DATE_MATCHERS, chronoDate]) {
    const hit = match(text, now);
    if (!hit) continue;
    dateRange = hit.range;
    chips.push({ type: 'date', label: formatRange(hit.range), raw: hit.raw.trim() });
    text = strip(text, hit.raw);
    break;
  }

  const colors = new Set<string>();
  for (const m of text.matchAll(COLOR_RE)) {
    const buckets = COLOR_WORDS[m[1]!.toLowerCase()]!;
    buckets.forEach((b) => colors.add(b));
    chips.push({ type: 'color', label: buckets.join('/'), raw: m[0] });
  }
  // Color words stay in the text: "Blue Bottle Coffee" should still match by title.

  return {
    text: text.replace(/\s+/g, ' ').trim(),
    sources,
    dateRange,
    colors: [...colors],
    chips,
  };
}
