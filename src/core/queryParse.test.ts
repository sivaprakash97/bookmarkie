import { describe, expect, it } from 'vitest';
import { parseQuery } from './queryParse';

// Monday 12 Oct 2026, local noon.
const NOW = new Date(2026, 9, 12, 12).getTime();
const d = (y: number, m: number, day = 1) => new Date(y, m - 1, day).getTime();

describe('parseQuery', () => {
  it('passes plain keywords through', () => {
    const p = parseQuery('react hooks article', NOW);
    expect(p).toMatchObject({ text: 'react hooks article', colors: [], chips: [] });
    expect(p.sources).toBeUndefined();
    expect(p.dateRange).toBeUndefined();
  });

  it('pulls out sources', () => {
    expect(parseQuery('pricing post from linkedin', NOW)).toMatchObject({ text: 'pricing post', sources: ['linkedin'] });
    expect(parseQuery('that tweet about rust', NOW)).toMatchObject({ text: 'that about rust', sources: ['x'] });
    expect(parseQuery('design inspo on insta', NOW).sources).toEqual(['instagram']);
    expect(parseQuery('docs on x', NOW).sources).toEqual(['x']);
    expect(parseQuery('xylophone tips', NOW).sources).toBeUndefined();
    expect(parseQuery('my chrome bookmarks about css', NOW)).toMatchObject({
      text: 'my about css',
      sources: ['chrome', 'readinglist'],
    });
  });

  it('understands relative dates', () => {
    expect(parseQuery('recipes last month', NOW)).toMatchObject({
      text: 'recipes',
      dateRange: { from: d(2026, 9), to: d(2026, 10) },
    });
    expect(parseQuery('yesterday', NOW).dateRange).toEqual({ from: d(2026, 10, 11), to: d(2026, 10, 12) });
    expect(parseQuery('this week', NOW).dateRange).toEqual({ from: d(2026, 10, 12), to: d(2026, 10, 19) });
    expect(parseQuery('saved in the past 2 weeks', NOW)).toMatchObject({ text: '', dateRange: { to: NOW } });
    const ago = parseQuery('chart 2 weeks ago', NOW);
    expect(ago.text).toBe('chart');
    expect(ago.dateRange!.from).toBeLessThan(NOW - 14 * 86_400_000);
    expect(ago.dateRange!.to).toBeGreaterThan(NOW - 14 * 86_400_000);
  });

  it('understands seasons and years', () => {
    // Autumn now, so "last spring" and "summer" both mean 2026.
    expect(parseQuery('last spring', NOW).dateRange).toEqual({ from: d(2026, 3), to: d(2026, 6) });
    expect(parseQuery('from the summer', NOW).dateRange).toEqual({ from: d(2026, 6), to: d(2026, 9) });
    // "last fall" while it's fall means the previous one.
    expect(parseQuery('last fall', NOW).dateRange).toEqual({ from: d(2025, 9), to: d(2025, 12) });
    expect(parseQuery('winter 2024', NOW).dateRange).toEqual({ from: d(2024, 12), to: d(2025, 3) });
    expect(parseQuery('talks in 2024', NOW)).toMatchObject({ text: 'talks', dateRange: { from: d(2024, 1), to: d(2025, 1) } });
    expect(parseQuery('since 2025', NOW).dateRange).toEqual({ from: d(2025, 1) });
  });

  it('resolves month names to the past', () => {
    expect(parseQuery('in march', NOW).dateRange).toEqual({ from: d(2026, 3), to: d(2026, 4) });
    expect(parseQuery('before june 2024', NOW).dateRange).toEqual({ to: d(2024, 6) });
    expect(parseQuery('newsletter since august', NOW)).toMatchObject({ text: 'newsletter', dateRange: { from: d(2026, 8) } });
  });

  it('tags colors but keeps the words for title matching', () => {
    const p = parseQuery('navy blue landing page', NOW);
    expect(p.colors).toEqual(['blue']);
    expect(p.text).toBe('navy blue landing page');
    expect(p.chips.filter((c) => c.type === 'color')).toHaveLength(2);
  });

  it('combines everything', () => {
    const p = parseQuery('the blue infographic about pricing from linkedin last spring', NOW);
    expect(p.text).toBe('the blue infographic about pricing');
    expect(p.sources).toEqual(['linkedin']);
    expect(p.dateRange).toEqual({ from: d(2026, 3), to: d(2026, 6) });
    expect(p.colors).toEqual(['blue']);
  });
});
