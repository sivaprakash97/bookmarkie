import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from './fixtures';

// Runs on a copy of the build, so rewriting files doesn't affect other tests.
const dir = mkdtempSync(path.join(os.tmpdir(), 'bookmarkie-update-'));
const realId = (JSON.parse(readFileSync('.output/chrome-mv3/build.json', 'utf8')) as { id: string }).id;

/** Stamps a build id into both the code and build.json, like a real rebuild would. */
function stamp(id: string, from: string) {
  const bg = path.join(dir, 'background.js');
  writeFileSync(bg, readFileSync(bg, 'utf8').replaceAll(`"${from}"`, `"${id}"`));
  writeFileSync(path.join(dir, 'build.json'), JSON.stringify({ id }));
}

test.beforeAll(() => {
  cpSync('.output/chrome-mv3', dir, { recursive: true, filter: (src) => !src.includes(`${path.sep}models`) });
  stamp('build-one', realId);
});
test.afterAll(() => rmSync(dir, { recursive: true, force: true }));
test.use({ extensionDir: dir });

test('reloads itself when the folder holds a newer build, and reopens the app', async ({ context, extensionId }) => {
  // As on a real install: "Load unpacked" needs Developer mode on, and Chrome checks it again on reload.
  // The extensions page also stays open, the way other tabs keep the window open in real use.
  const extensionsPage = await context.newPage();
  await extensionsPage.goto('chrome://extensions');
  await extensionsPage.evaluate(() =>
    (globalThis as any).chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }),
  );
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/app.html`);
  await expect(page.getByRole('searchbox')).toBeVisible();

  // Same build: nothing happens.
  await page.reload();
  await page.waitForTimeout(1000);
  expect(page.isClosed()).toBe(false);

  // "Run the updater": a new build lands in the folder.
  stamp('build-two', 'build-one');
  const reopened = context.waitForEvent('page', { predicate: (p) => p.url().includes('app.html') });
  await page.reload().catch(() => undefined);
  const fresh = await reopened;
  await expect(fresh.getByRole('status')).toContainText('Bookmarkie was updated to the latest version.');
  await expect(fresh.getByRole('searchbox')).toBeVisible();

  // The new build is running: no reload loop.
  await fresh.waitForTimeout(1500);
  expect(fresh.isClosed()).toBe(false);
  expect(fresh.url()).not.toContain('updated=1');
});
