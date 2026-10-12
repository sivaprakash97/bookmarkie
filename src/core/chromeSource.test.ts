import { describe, expect, it } from 'vitest';
import { flattenBookmarkTree, readingListToInputs } from './chromeSource';

describe('flattenBookmarkTree', () => {
  it('produces folder paths and skips the invisible root', () => {
    const tree = [{
      id: '0', title: '', children: [
        { id: '1', title: 'Bookmarks bar', children: [
          { id: '10', title: 'Hacker News', url: 'https://news.ycombinator.com/', dateAdded: 5 },
          { id: '11', title: 'Dev', children: [{ id: '12', title: 'MDN', url: 'https://developer.mozilla.org/' }] },
        ] },
        { id: '2', title: 'Other bookmarks', children: [] },
      ],
    }];
    expect(flattenBookmarkTree(tree)).toEqual([
      { source: 'chrome', sourceId: '10', url: 'https://news.ycombinator.com/', title: 'Hacker News', folderPath: 'Bookmarks bar', savedAt: 5 },
      { source: 'chrome', sourceId: '12', url: 'https://developer.mozilla.org/', title: 'MDN', folderPath: 'Bookmarks bar / Dev', savedAt: undefined },
    ]);
  });
});

describe('readingListToInputs', () => {
  it('keys entries by URL', () => {
    expect(readingListToInputs([{ url: 'https://a.dev/', title: 'A', hasBeenRead: false, creationTime: 9 }])).toEqual([
      { source: 'readinglist', sourceId: 'https://a.dev/', url: 'https://a.dev/', title: 'A', folderPath: 'Reading list / Unread', savedAt: 9 },
    ]);
  });
});
