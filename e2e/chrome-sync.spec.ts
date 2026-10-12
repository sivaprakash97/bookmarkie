import { expect, test } from './fixtures';

declare const chrome: any;

test('Chrome bookmarks sync live into the app and are searchable', async ({ context, sw, extensionId }) => {
  // Seed bookmarks through the real chrome.bookmarks API.
  const ids = await sw.evaluate(async () => {
    const bar = '1';
    const dev = await chrome.bookmarks.create({ parentId: bar, title: 'Dev' });
    const a = await chrome.bookmarks.create({ parentId: dev.id, title: 'A Complete Guide to useEffect', url: 'https://overreacted.io/a-complete-guide-to-useeffect/' });
    const b = await chrome.bookmarks.create({ parentId: bar, title: 'SaaS pricing teardown', url: 'https://example.com/pricing?utm_source=newsletter' });
    return { dev: dev.id, a: a.id, b: b.id };
  });

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/app.html`);
  const rows = page.locator('.results .row');

  // Initial sync, folder path shown.
  await expect(rows.filter({ hasText: 'A Complete Guide to useEffect' })).toContainText('Bookmarks bar / Dev');
  await expect(rows.filter({ hasText: 'SaaS pricing teardown' })).toHaveCount(1);

  // Search with a typo and filler words.
  const input = page.getByRole('searchbox', { name: 'Search bookmarks' });
  await input.fill('that guide about useefect');
  await expect(rows.first()).toContainText('A Complete Guide to useEffect');

  // A bookmark added while the app is open appears without reloading.
  await input.fill('');
  await sw.evaluate(() =>
    chrome.bookmarks.create({ parentId: '2', title: 'Rust async book', url: 'https://rust-lang.github.io/async-book/' }),
  );
  await expect(rows.filter({ hasText: 'Rust async book' })).toHaveCount(1, { timeout: 2_000 });

  // Same URL bookmarked twice (with tracking junk) stays one result.
  await sw.evaluate(() =>
    chrome.bookmarks.create({ parentId: '2', title: 'Pricing again', url: 'https://www.example.com/pricing/' }),
  );
  await input.fill('pricing');
  await expect(rows).toHaveCount(1);

  // Deleting in Chrome hides it, but it's still findable with "Include removed".
  await sw.evaluate(async (id) => {
    await chrome.bookmarks.remove(id);
  }, ids.a);
  await input.fill('useeffect');
  await expect(page.getByText('Nothing matches.')).toBeVisible();
  await page.getByLabel('Include removed').check();
  await expect(rows.first()).toContainText('Removed from Chrome');

  // Natural-language source filter shows a chip that can be removed.
  await input.fill('rust from chrome');
  await expect(page.locator('.chip-source')).toContainText('Chrome');
  await expect(rows.first()).toContainText('Rust async book');

  // Sources page reports sync status.
  await page.getByRole('button', { name: 'Sources' }).click();
  await expect(page.locator('.source-card').first()).toContainText('Connected');
});
