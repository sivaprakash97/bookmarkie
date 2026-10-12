const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400_000],
  ['month', 30 * 86_400_000],
  ['week', 7 * 86_400_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

export function relativeTime(t: number, now = Date.now()): string {
  const diff = t - now;
  for (const [unit, ms] of STEPS) {
    if (Math.abs(diff) >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return 'just now';
}

export function absoluteDate(t: number): string {
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "example.com/some/path" without protocol, query noise or trailing slash. */
export function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return url;
    const path = decodeURIComponent(u.pathname).replace(/\/$/, '');
    return u.hostname.replace(/^www\./, '') + path;
  } catch {
    return url;
  }
}

/** Chrome's favicon cache for extensions ("favicon" permission). The app runs on the extension origin. */
export function faviconUrl(pageUrl: string): string {
  const u = new URL('/_favicon/', location.origin);
  u.searchParams.set('pageUrl', pageUrl);
  u.searchParams.set('size', '32');
  return u.toString();
}
