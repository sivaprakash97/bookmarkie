import { existsSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page, Worker } from '@playwright/test';
import { expect, test } from './fixtures';

declare const chrome: any;

async function seed(sw: Worker, folder: string, bookmarks: [string, string][]) {
  return sw.evaluate(
    async ({ folder, bookmarks }) => {
      const f = await chrome.bookmarks.create({ parentId: '1', title: folder });
      for (const [title, url] of bookmarks) await chrome.bookmarks.create({ parentId: f.id, title, url });
      return f.id as string;
    },
    { folder, bookmarks },
  );
}

const titlesIn = (sw: Worker, folderId: string) =>
  sw.evaluate(async (id) => (await chrome.bookmarks.getChildren(id)).map((b: { title: string }) => b.title), folderId);

async function openApp(page: Page, extensionId: string, rows: number) {
  await page.goto(`chrome-extension://${extensionId}/app.html`);
  await expect(page.locator('.results .row')).toHaveCount(rows);
}

test('select from search, review, delete, undo', async ({ context, sw, extensionId }) => {
  const folder = await seed(sw, 'College', [
    ['GATE exam papers', 'https://exams.example/gate'],
    ['Hostel mess menu', 'https://hostel.example/menu'],
    ['Figma auto layout', 'https://help.figma.com/auto-layout'],
  ]);
  const page = await context.newPage();
  await openApp(page, extensionId, 3);

  await page.getByRole('button', { name: 'Select' }).click();
  await page.getByRole('searchbox').fill('college');
  await page.getByRole('button', { name: 'Select all 3 results' }).click();
  await page.getByRole('button', { name: 'Review & remove →' }).click();

  // Review lists every bookmark with its reason; nothing is deleted yet.
  const review = page.locator('.review-list li');
  await expect(page.getByRole('heading', { name: 'Review before deleting' })).toBeVisible();
  await expect(review).toHaveCount(3);
  await expect(review.first()).toContainText('You selected it (search: "college")');
  await expect(review.first()).toContainText('Bookmarks bar / College');

  // Back deletes nothing.
  await page.getByRole('button', { name: '← Back, delete nothing' }).click();
  expect(await titlesIn(sw, folder)).toHaveLength(3);

  // Untick one, delete the rest.
  await page.getByRole('button', { name: 'Review & remove →' }).click();
  await page.getByLabel('Delete Figma auto layout').uncheck();
  await page.getByRole('button', { name: 'Delete 2 bookmarks from Chrome' }).click();
  await expect(page.getByText('Download a backup first?')).toBeVisible();
  await page.getByRole('button', { name: 'Delete without backup' }).click();

  await expect(page.getByRole('status')).toContainText('Deleted 2 bookmarks from Chrome.');
  expect(await titlesIn(sw, folder)).toEqual(['Figma auto layout']);
  await page.getByRole('searchbox').fill('college');
  await expect(page.locator('.results .row')).toHaveCount(1);

  // Undo puts them back in their original places.
  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('status')).toContainText('Restored 2 bookmarks.');
  expect(await titlesIn(sw, folder)).toEqual(['GATE exam papers', 'Hostel mess menu', 'Figma auto layout']);
});

test('duplicates keep the oldest copy', async ({ context, sw, extensionId }) => {
  const folder = await seed(sw, 'Dupes', [
    ['First copy', 'https://dup.example/page'],
    ['Second copy', 'https://www.dup.example/page/?utm_source=newsletter'],
    ['Unique', 'https://unique.example/'],
  ]);
  const page = await context.newPage();
  await openApp(page, extensionId, 2);
  await page.getByRole('button', { name: 'Clean up' }).click();
  await expect(page.getByText('bookmarked more than once')).toContainText('1 link is bookmarked more than once');
  await page.getByRole('button', { name: 'Review 1 extra copy →' }).click();
  await expect(page.locator('.review-list li')).toHaveCount(1);
  await expect(page.locator('.review-list li')).toContainText('Second copy');
  await page.getByRole('button', { name: 'Delete 1 bookmark from Chrome' }).click();
  await page.getByRole('button', { name: 'Delete without backup' }).click();
  await expect(page.getByRole('status')).toContainText('Deleted 1 bookmark');
  expect(await titlesIn(sw, folder)).toEqual(['First copy', 'Unique']);

  // Deleted bookmarks are listed under Recently removed with Undo.
  await page.getByRole('button', { name: 'Clean up' }).click();
  await expect(page.locator('#recently-removed')).toContainText('1 bookmark');
});

test('dead links', async ({ context, sw, extensionId }) => {
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === '/gone' ? 404 : req.url === '/blocked' ? 403 : 200).end('ok');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await seed(sw, 'Links', [
      ['Alive', `${base}/alive`],
      ['Gone', `${base}/gone`],
      ['Blocked', `${base}/blocked`],
    ]);
    const page = await context.newPage();
    await openApp(page, extensionId, 3);
    await page.getByRole('button', { name: 'Clean up' }).click();
    await page.getByRole('button', { name: 'Check 3 links' }).click();
    await expect(page.getByRole('button', { name: 'Review 1 dead link →' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: "Review 1 that couldn't be checked →" })).toBeVisible();

    await page.getByRole('button', { name: 'Review 1 dead link →' }).click();
    await expect(page.locator('.review-list li')).toHaveCount(1);
    await expect(page.locator('.review-list li')).toContainText('The site answered 404');
    await page.getByRole('button', { name: '← Back, delete nothing' }).click();

    // "Couldn't check" ones open unticked.
    await page.getByRole('button', { name: "Review 1 that couldn't be checked →" }).click();
    await expect(page.getByLabel('Delete Blocked')).not.toBeChecked();
    await expect(page.getByRole('button', { name: 'Delete 0 bookmarks from Chrome' })).toBeDisabled();
  } finally {
    server.close();
  }
});

const modelInstalled =
  existsSync('.output/chrome-mv3/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx') ||
  existsSync('.output/chrome-mv3/models/Xenova/all-MiniLM-L6-v2/onnx/model.onnx');

test('not about my topics, with the real on-device model', async ({ context, sw, extensionId }) => {
  test.skip(!modelInstalled, 'AI model not downloaded');
  test.setTimeout(120_000);
  await seed(sw, 'Old stuff', [
    ['Figma auto layout guide', 'https://help.figma.com/hc/en-us/articles/auto-layout'],
    ['The best free fonts for headlines', 'https://www.creativebloq.com/features/best-free-fonts'],
    ['Brand identity for a coffee shop', 'https://www.behance.net/gallery/1/coffee-brand'],
    ['Material Design 3 components', 'https://m3.material.io/components'],
    ['Pasta carbonara recipe', 'https://www.bonappetit.com/recipe/carbonara'],
    ['Calculus lecture notes', 'https://ocw.mit.edu/courses/calculus'],
    ['IPL 2018 live score', 'https://www.cricbuzz.com/live'],
    ['Cheap flights to Goa', 'https://www.makemytrip.com/flights/goa'],
  ]);
  const page = await context.newPage();
  // The folder name "Old stuff" isn't a design word, so nothing is kept by folder rule.
  await openApp(page, extensionId, 8);
  await page.getByRole('button', { name: 'Clean up' }).click();
  await page.getByRole('button', { name: 'Find unrelated bookmarks' }).click();
  await expect(page.getByRole('button', { name: /^Review \d+ bookmarks? →$/ })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: /^Review \d+ bookmarks? →$/ }).click();

  const titles = await page.locator('.review-list .title-text').allTextContents();
  expect(titles.sort()).toEqual(['Calculus lecture notes', 'Cheap flights to Goa', 'IPL 2018 live score', 'Pasta carbonara recipe']);
  await expect(page.locator('.review-list li').first()).toContainText('Not about your topics');
});
