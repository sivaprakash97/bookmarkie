import { chromium, expect, test as base, type BrowserContext, type Worker } from '@playwright/test';
import path from 'node:path';

const extensionPath = path.resolve('.output/chrome-mv3');

export const test = base.extend<{ context: BrowserContext; sw: Worker; extensionId: string }>({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    await use(context);
    await context.close();
  },
  sw: async ({ context }, use) => {
    const ours = (w: Worker) => w.url().endsWith('/background.js');
    const sw =
      context.serviceWorkers().find(ours) ??
      (await context.waitForEvent('serviceworker', { predicate: ours }));
    // Extension APIs attach to the worker a moment after it starts.
    await expect
      .poll(() => sw.evaluate(() => typeof (globalThis as any).chrome?.bookmarks?.create))
      .toBe('function');
    await use(sw);
  },
  extensionId: async ({ sw }, use) => {
    await use(new URL(sw.url()).host);
  },
});


export { expect };
