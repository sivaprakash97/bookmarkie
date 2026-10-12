import type { Kind } from './types';

const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'yclid', 'twclid', 'igsh', 'igshid',
  'mc_cid', 'mc_eid', '_ga', '_gl', 'ref', 'ref_src', 'ref_url', 'si',
  'trk', 'trackingid', 'lipi', 'midtoken', 'rcm',
]);

const HOST_ALIASES: Record<string, string> = {
  'twitter.com': 'x.com',
  'mobile.twitter.com': 'x.com',
  'mobile.x.com': 'x.com',
};

function isTrackingParam(host: string, name: string): boolean {
  const n = name.toLowerCase();
  if (n.startsWith('utm_') || TRACKING_PARAMS.has(n)) return true;
  // X share links append ?s=20&t=<token>; they never change the target.
  return host === 'x.com' && (n === 's' || n === 't');
}

/**
 * Normalizes a URL so the same link saved on different platforms (or with
 * different tracking junk) collapses to one key. Non-http(s) URLs are returned
 * as-is apart from trimming.
 */
export function canonicalize(raw: string): string {
  const input = raw.trim();
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return input;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return input;

  let host = u.hostname.toLowerCase().replace(/^www\./, '');
  host = HOST_ALIASES[host] ?? host;
  let path = u.pathname.replace(/\/+$/, '') || '/';

  // Platform post URLs: reduce to the stable post id.
  if (host === 'x.com') {
    const m = path.match(/^\/(?:[^/]+|i(?:\/web)?)\/status(?:es)?\/(\d+)/);
    if (m) return `https://x.com/i/status/${m[1]}`;
  }
  if (host === 'instagram.com') {
    const m = path.match(/^\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([\w-]+)/);
    if (m) return `https://instagram.com/p/${m[1]}`;
  }
  if (host === 'linkedin.com') {
    const m =
      path.match(/^\/feed\/update\/urn:li:activity:(\d+)/) ??
      path.match(/^\/posts\/.*-activity-(\d+)(?:-|$)/);
    if (m) return `https://linkedin.com/feed/update/urn:li:activity:${m[1]}`;
  }

  const params = [...u.searchParams.entries()]
    .filter(([k]) => !isTrackingParam(host, k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params.length ? '?' + new URLSearchParams(params).toString() : '';
  // Keep meaningful fragments (SPA routes) but drop text-fragment highlights.
  const hash = u.hash && !u.hash.startsWith('#:~:') && u.hash !== '#' ? u.hash : '';
  const port = u.port ? `:${u.port}` : '';
  return `https://${host}${port}${path === '/' ? '' : path}${query}${hash}`;
}

export function siteNameOf(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return u.protocol.replace(':', '');
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    return HOST_ALIASES[host] ?? host;
  } catch {
    return '';
  }
}

export function guessKind(canonicalUrl: string): Kind {
  if (/^https:\/\/x\.com\/i\/status\//.test(canonicalUrl)) return 'post';
  if (/^https:\/\/linkedin\.com\/feed\/update\//.test(canonicalUrl)) return 'post';
  if (/^https:\/\/instagram\.com\/p\//.test(canonicalUrl)) return 'post';
  if (/^https:\/\/(youtube\.com\/watch|youtu\.be\/|vimeo\.com\/\d)/.test(canonicalUrl)) return 'video';
  if (/\.(png|jpe?g|gif|webp|avif|svg)(\?|$)/i.test(canonicalUrl)) return 'image';
  return 'page';
}

const OPENABLE = new Set(['http:', 'https:', 'ftp:', 'file:', 'chrome:']);

/** Bookmarklets and data: URLs are stored but never opened from the app. */
export function isOpenable(url: string): boolean {
  try {
    return OPENABLE.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

export function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}
