# Bookmarkie

All your bookmarks in one place, searchable in plain language.

Bookmarkie is a Chrome extension with a full-page search app. It collects your bookmarks automatically, with no exporting or importing, and lets you find a link by describing it: *"pricing article from linkedin last spring"*, *"that react hooks guide"*, *"recipes in 2024"*.

| Source | Status |
| --- | --- |
| Chrome bookmarks | ✅ Synced live: adds, edits, moves and deletes show up within a second, including bookmarks synced from your phone |
| Chrome Reading List | ✅ Synced live |
| Clean up old bookmarks | ✅ Remove by search, by topic (free on-device AI), dead links and duplicates, with review and undo |
| X / Twitter | 🔜 Next milestone |
| LinkedIn, Instagram | 🗓 Planned |
| Smart search with free on-device AI (Chrome's built-in Gemini Nano), color search | 🗓 Planned. Claude is an optional upgrade if you add your own key |

See [`docs/PLAN.md`](docs/PLAN.md) for the full design and roadmap.

## Install (for personal use)

```bash
npm install
npm run build
```

`npm install` also downloads the small AI model used by Clean up (about 23 MB, once), so be online for it.

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

## Cleaning up old bookmarks

Nothing is ever deleted without you seeing it first. Every route ends on a **Review** screen that lists each bookmark with the reason it's there. You can untick anything, open a page to check it, or download the list as a spreadsheet. Only the button at the bottom of that screen deletes.

- **From a search:** click **Select**, search (e.g. `before 2020`), click **Select all**, then **Review & remove**.
- **Not about my topics:** in **Clean up**, type the topics you want to keep (e.g. `design, typography`) and click **Find unrelated bookmarks**.
  - An AI model running on your computer compares each bookmark's title and address with your topics. It's free and nothing leaves your computer.
  - Use the **Strictness** slider to flag more or fewer.
  - Bookmarks on known design sites, or in folders named after your topics, are always kept.
- **Dead links:** Chrome asks once for permission to visit the pages. Then Bookmarkie lists pages that no longer exist. Pages that block the check are listed separately and start unticked.
- **Duplicates:** links bookmarked more than once. The oldest copy is kept.

**Safety net:**
- You're offered a backup file (importable into any browser) before your first deletion.
- Deleted bookmarks stay under **Clean up → Recently removed** for 30 days. **Undo** puts them back in their original folder. Chrome resets their "date added" when they come back.

## Updating

1. Download the new code and replace the files **in the same folder** you loaded into Chrome. Chrome identifies an unpacked extension by its folder, so keep the folder name and location.
2. In that folder run `npm install`, then `npm run build`.
3. Open `chrome://extensions` and click the reload ↻ icon on Bookmarkie.

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
  cleanup.ts               delete with trash + undo, duplicates, backup export
  linkCheck.ts             dead-link checks
  embed.ts, topics.ts      on-device embeddings and topic scoring
  chromeSource.ts, sync.ts Chrome bookmarks + Reading List sync
src/entrypoints/
  background.ts            service worker: sync listeners, alarm, toolbar, omnibox
  app/                     React app (search, clean up, review, sources)
  app/embed.worker.ts      runs the AI model (Transformers.js, bundled ONNX runtime) off the main thread
scripts/prepare-assets.mjs puts the model and ONNX runtime into public/ (run automatically)
e2e/                       Playwright tests that load the built extension
```
