# Bookmarkie

All your bookmarks in one place, searchable in plain language.

Bookmarkie is a Chrome extension with a full-page search app. It collects your bookmarks automatically, with no exporting or importing, and lets you find a link by describing it: *"pricing article from linkedin last spring"*, *"that react hooks guide"*, *"recipes in 2024"*.

| Source | Status |
| --- | --- |
| Chrome bookmarks | ✅ Synced live: adds, edits, moves and deletes show up within a second, including bookmarks synced from your phone |
| Chrome Reading List | ✅ Synced live |
| X / Twitter | 🔜 Next milestone |
| LinkedIn, Instagram | 🗓 Planned |
| AI search (Claude), color search | 🗓 Planned |

See [`docs/PLAN.md`](docs/PLAN.md) for the full design and roadmap.

## Install (for personal use)

```bash
npm install
npm run build
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick the `.output/chrome-mv3` folder.
3. Your Chrome bookmarks are imported right away and kept in sync from then on.

## Using it

- **Open the app:** click the toolbar icon or press **Alt+Shift+B**.
- **Search from the address bar:** type `bm`, then a space, then your query.
- **What a query understands:**
  - **Words** are matched in titles, URLs, site names and folder names. Small typos and partial words are fine (`reakt`, `pric`).
  - **Where it was saved:** `from linkedin`, `tweets`, `on insta`, `reading list`, `chrome`.
  - **When it was saved:** `yesterday`, `last month`, `past 2 weeks`, `3 months ago`, `last spring`, `in 2024`, `since march`, `before june 2024`.
  - **Colors:** words like `blue` or `navy` bring color matches to the top. This becomes useful once image colors are extracted in a later milestone.
- Each filter shows up as a chip under the search box; click it to remove it.
- **Keyboard:** <kbd>↑</kbd>/<kbd>↓</kbd> to move, <kbd>Enter</kbd> to open (<kbd>Ctrl/Cmd</kbd>+<kbd>Enter</kbd> opens in the background), <kbd>/</kbd> to jump to search, <kbd>Esc</kbd> to clear.
- **Deleted bookmarks are never lost.** Tick **Include removed** to find links you've since deleted.

All data stays in your browser (IndexedDB). Nothing is sent anywhere.

## Development

```bash
npm run dev        # Chrome with the extension loaded and hot reload
npm test           # unit tests (Vitest)
npm run test:e2e   # builds, then runs Playwright against the real extension in Chromium
npm run compile    # type-check
```

Code layout:

```
src/core/                  shared logic, no UI
  canonical.ts             URL normalization so one link saved in several places becomes one result
  ingest.ts                the single write path every source uses (items + per-source saves)
  queryParse.ts            pulls source / date / color filters out of a query
  search/lexical.ts        MiniSearch index, filters, ranking
  chromeSource.ts, sync.ts Chrome bookmarks + Reading List sync
src/entrypoints/
  background.ts            service worker: sync listeners, alarm, toolbar, omnibox
  app/                     React search app
e2e/                       Playwright tests that load the built extension
```
