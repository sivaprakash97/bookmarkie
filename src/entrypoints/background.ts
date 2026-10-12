import { canonicalize, isWebUrl } from '@/core/canonical';
import { db } from '@/core/db';
import { parseQuery } from '@/core/queryParse';
import { LexicalIndex } from '@/core/search/lexical';
import { syncChromeBookmarks, syncReadingList } from '@/core/sync';

const APP_PATH = '/app.html';
const RECONCILE_ALARM = 'reconcile';
const IMPORTING_KEY = 'chromeImporting';

export default defineBackground(() => {
  // ---- Chrome bookmarks & Reading List: kept in sync with no user action. ----
  // Every listener is registered synchronously so events can wake the worker.

  const timers: Record<string, ReturnType<typeof setTimeout>> = {};
  const schedule = (key: 'chrome' | 'readinglist', delay = 300) => {
    clearTimeout(timers[key]);
    timers[key] = setTimeout(async () => {
      if (key === 'chrome') {
        // Bulk imports fire thousands of events; sync once when they finish.
        const { [IMPORTING_KEY]: importing } = await browser.storage.session.get(IMPORTING_KEY);
        if (importing) return;
        await syncChromeBookmarks();
      } else {
        await syncReadingList();
      }
      searchIndex = null;
    }, delay);
  };

  const syncAll = () => {
    schedule('chrome', 0);
    schedule('readinglist', 0);
  };

  browser.runtime.onInstalled.addListener(syncAll);
  browser.runtime.onStartup.addListener(syncAll);

  browser.bookmarks.onCreated.addListener(() => schedule('chrome'));
  browser.bookmarks.onChanged.addListener(() => schedule('chrome'));
  browser.bookmarks.onMoved.addListener(() => schedule('chrome'));
  browser.bookmarks.onRemoved.addListener(() => schedule('chrome'));
  browser.bookmarks.onChildrenReordered.addListener(() => schedule('chrome'));
  browser.bookmarks.onImportBegan.addListener(() => {
    void browser.storage.session.set({ [IMPORTING_KEY]: true });
  });
  browser.bookmarks.onImportEnded.addListener(async () => {
    await browser.storage.session.set({ [IMPORTING_KEY]: false });
    schedule('chrome', 0);
  });

  if (browser.readingList) {
    browser.readingList.onEntryAdded.addListener(() => schedule('readinglist'));
    browser.readingList.onEntryUpdated.addListener(() => schedule('readinglist'));
    browser.readingList.onEntryRemoved.addListener(() => schedule('readinglist'));
  }

  // Safety net for anything missed while the browser was closed or the worker was asleep.
  browser.alarms.get(RECONCILE_ALARM).then((a) => {
    if (!a) void browser.alarms.create(RECONCILE_ALARM, { periodInMinutes: 360 });
  });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RECONCILE_ALARM) syncAll();
  });

  // ---- Ways in: toolbar icon / Alt+Shift+B, and "bm <query>" in the address bar. ----

  browser.action.onClicked.addListener(() => void openApp());

  let searchIndex: LexicalIndex | null = null;
  const getIndex = async () => (searchIndex ??= new LexicalIndex(await db.items.toArray()));

  browser.omnibox.setDefaultSuggestion({ description: 'Search Bookmarkie for: %s' });

  browser.omnibox.onInputChanged.addListener(async (text, suggest) => {
    const parsed = parseQuery(text);
    const hits = (await getIndex()).search(parsed, { limit: 6 });
    suggest(
      hits
        .filter((h) => isWebUrl(h.item.url))
        .map((h) => ({
          content: h.item.url,
          description: `${escapeXml(h.item.title)} <dim>${escapeXml(h.item.siteName)}</dim>`,
        })),
    );
  });

  browser.omnibox.onInputEntered.addListener(async (text, disposition) => {
    // A picked suggestion arrives as its URL; anything else is a query for the app.
    const items = isWebUrl(text) ? await db.items.where('canonicalUrl').equals(canonicalize(text)).count() : 0;
    if (items) {
      if (disposition === 'currentTab') await browser.tabs.update({ url: text });
      else await browser.tabs.create({ url: text, active: disposition === 'newForegroundTab' });
      return;
    }
    await openApp(text);
  });
});

async function openApp(query?: string): Promise<void> {
  const base = browser.runtime.getURL(APP_PATH);
  const url = query ? `${base}?q=${encodeURIComponent(query)}` : base;
  // getContexts sees our own pages without needing the "tabs" permission.
  const contexts = await browser.runtime.getContexts({ contextTypes: [browser.runtime.ContextType.TAB] });
  const existing = contexts.find((c) => c.documentUrl?.startsWith(base));
  if (existing && existing.tabId >= 0) {
    await browser.tabs.update(existing.tabId, { active: true, ...(query ? { url } : {}) });
    await browser.windows.update(existing.windowId, { focused: true });
    return;
  }
  await browser.tabs.create({ url });
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": 'apos' }[c]};`);
}
