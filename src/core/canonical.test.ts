import { describe, expect, it } from 'vitest';
import { canonicalize, guessKind, isOpenable } from './canonical';

describe('canonicalize', () => {
  it('strips tracking params, www, trailing slash, and sorts the rest', () => {
    expect(canonicalize('http://www.Example.com/a/b/?utm_source=x&b=2&fbclid=1&a=1')).toBe(
      'https://example.com/a/b?a=1&b=2',
    );
  });

  it('keeps meaningful fragments but drops text highlights', () => {
    expect(canonicalize('https://app.example.com/#/settings')).toBe('https://app.example.com#/settings');
    expect(canonicalize('https://example.com/post#:~:text=hello')).toBe('https://example.com/post');
  });

  it('folds X/Twitter status URLs to the post id', () => {
    const want = 'https://x.com/i/status/1789';
    expect(canonicalize('https://twitter.com/someone/status/1789?s=20&t=abc')).toBe(want);
    expect(canonicalize('https://mobile.x.com/Someone/status/1789/photo/1')).toBe(want);
    expect(canonicalize('https://x.com/i/web/status/1789')).toBe(want);
  });

  it('folds Instagram post and reel URLs', () => {
    expect(canonicalize('https://www.instagram.com/reel/Cx_Yz-1/?igsh=abc')).toBe('https://instagram.com/p/Cx_Yz-1');
    expect(canonicalize('https://instagram.com/someuser/p/Cx_Yz-1/')).toBe('https://instagram.com/p/Cx_Yz-1');
  });

  it('folds LinkedIn post URLs to the activity id', () => {
    const want = 'https://linkedin.com/feed/update/urn:li:activity:7123';
    expect(canonicalize('https://www.linkedin.com/feed/update/urn:li:activity:7123/?trk=x')).toBe(want);
    expect(canonicalize('https://www.linkedin.com/posts/jane-doe_ai-activity-7123-AbCd?utm_source=share')).toBe(want);
  });

  it('leaves non-web URLs alone', () => {
    expect(canonicalize('javascript:alert(1)')).toBe('javascript:alert(1)');
    expect(canonicalize('chrome://settings/')).toBe('chrome://settings/');
    expect(canonicalize('  not a url ')).toBe('not a url');
  });
});

describe('guessKind / isOpenable', () => {
  it('classifies posts and videos', () => {
    expect(guessKind('https://x.com/i/status/1')).toBe('post');
    expect(guessKind('https://youtube.com/watch?v=abc')).toBe('video');
    expect(guessKind('https://example.com')).toBe('page');
  });

  it('never opens bookmarklets or data URLs', () => {
    expect(isOpenable('javascript:void(0)')).toBe(false);
    expect(isOpenable('data:text/html,hi')).toBe(false);
    expect(isOpenable('chrome://bookmarks')).toBe(true);
    expect(isOpenable('https://example.com')).toBe(true);
  });
});
