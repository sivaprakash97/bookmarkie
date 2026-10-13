import { browser } from 'wxt/browser';

// A folder-loaded ("unpacked") extension doesn't notice when its files are
// rebuilt. After the double-click updater rebuilds Bookmarkie, the new
// build.json no longer matches the build this code came from, so we reload.

const REOPEN_KEY = 'reopenAfterUpdate';
const LAST_TARGET_KEY = 'lastUpdateTarget';

export async function builtIdOnDisk(): Promise<string | null> {
  try {
    const res = await fetch(new URL('/build.json', self.location.origin), { cache: 'no-store' });
    if (!res.ok) return null;
    const { id } = (await res.json()) as { id?: unknown };
    return typeof id === 'string' ? id : null;
  } catch {
    // Mid-build the file is briefly missing.
    return null;
  }
}

/** Reloads the extension if the folder holds a newer build. Returns true when reloading. */
export async function reloadIfRebuilt(appIsOpen: () => Promise<boolean>): Promise<boolean> {
  const self = await browser.management.getSelf();
  if (self.installType !== 'development') return false;
  const onDisk = await builtIdOnDisk();
  if (!onDisk || onDisk === __BUILD_ID__) return false;

  // Never reload twice for the same build, in case Chrome kept old files around.
  const { [LAST_TARGET_KEY]: last } = await browser.storage.local.get(LAST_TARGET_KEY);
  if (last === onDisk) return false;

  await browser.storage.local.set({ [LAST_TARGET_KEY]: onDisk, [REOPEN_KEY]: (await appIsOpen()) ? Date.now() : 0 });
  browser.runtime.reload();
  return true;
}

/** After an update reload, reopens Bookmarkie if it was open before. */
export async function takeReopenRequest(): Promise<boolean> {
  const { [REOPEN_KEY]: at } = await browser.storage.local.get(REOPEN_KEY);
  if (at === undefined) return false;
  await browser.storage.local.remove(REOPEN_KEY);
  return typeof at === 'number' && at > 0 && Date.now() - at < 120_000;
}
