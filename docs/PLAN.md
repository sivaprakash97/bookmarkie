# Bookmarkie: one searchable home for every bookmark

## Context
The user's bookmarks are spread across Chrome, X, LinkedIn and Instagram, and they can't remember where they saved things. The repo is empty (README only).

The goal is a Chrome extension with a full-page app that:
1. **Collects bookmarks from all four sources automatically.** The user never exports or imports anything.
2. **Finds a bookmark from a loose description**: keywords, natural language, source, date or color ("the blue chart from LinkedIn last spring").

Agreed with the user: Chrome extension plus full-page app; data stays on the device; free on-device AI by default (Chrome's built-in Gemini Nano), with Claude (user's own key) as an optional upgrade; TypeScript + React + Vite, Manifest V3.

**Main constraint.** Only Chrome has a bookmarks API. The other three platforms have no public API for a user's saved items, and most social saves happen on phones. "Frictionless" therefore needs two capture paths:
- **(a) Passive:** watch the user's own logged-in desktop session and record saves as they happen.
- **(b) Auto-sync (opt-in):** periodically pull new saves (including ones made on mobile) using the user's session.

Each platform is an isolated adapter, so when one breaks the others keep working, and the health UI shows which one is broken.

## Architecture (WXT, which is built on Vite)
_Implementation note: WXT's `srcDir` is `src/`, so `entrypoints/` below lives at `src/entrypoints/`._

```
entrypoints/
  background.ts        # SW: event router only. Listeners at top level. Chrome sync, alarms,
                       # omnibox, commands, sync-tab orchestration, captureVisibleTab
  engine.html/.ts      # offscreen doc (reasons: DOM_PARSER, WORKERS): enrichment queue, page fetch
                       # + Readability, thumbnails/palette, Claude calls, embeddings (Web Worker)
  app/                 # React full-page app: search UI, sources/health, settings, onboarding
  x.content.ts  x-hook.content.ts (world: "MAIN", document_start)      # same pair for ig, li
src/core/  db.ts types.ts canonical.ts queryParse.ts search/{lexical,vector,fuse}.ts
           color.ts claude.ts embed.ts queue.ts messages.ts (zod schemas)
src/adapters/{x,instagram,linkedin}/  parse.ts (pure) · endpoints.ts (versioned) · sync.ts
test/fixtures/{x,instagram,linkedin,pages}/  recorded, sanitized JSON/HTML
```
- **Why WXT instead of CRXJS:** it bundles content scripts as IIFE, so `world: "MAIN"` scripts work. CRXJS's loader uses `chrome.runtime` dynamic imports, and those fail in the page's main world. WXT also handles unlisted/offscreen pages and Playwright-friendly builds.
- **Why an offscreen "engine":**
  - The SW is killed after about 30s idle and has no DOMParser.
  - Running the embedding model (WASM) is simpler in a page context.
  - The engine is created on demand and closed when the queue is empty, which frees about 150MB of model memory.
- **Shared storage:** all contexts share the extension-origin IndexedDB through Dexie; `liveQuery` updates the app UI.
- **Required permissions:** `bookmarks`, `readingList`, `storage`, `unlimitedStorage`, `alarms`, `offscreen`, `scripting`, `favicon`.
- **Host permissions:** x.com, twitter.com, *.twimg.com, instagram.com, *.cdninstagram.com, *.fbcdn.net, linkedin.com, *.licdn.com, api.anthropic.com.
- **Optional, requested in onboarding:** `<all_urls>` ("read bookmarked pages for better search"), `idle`.
- **CSP:** `script-src 'self' 'wasm-unsafe-eval'`. The ONNX runtime and model weights ship inside the extension; nothing is loaded from a CDN.

## AI providers: free by default, Claude optional (revision)
The user wants to avoid paying for AI. Every AI step goes through one `AiProvider` interface (`src/core/ai/`), and the free on-device providers are the default:

| Job | Default (free, on-device) | Optional upgrade |
| --- | --- | --- |
| Meaning-based search | Bundled `all-MiniLM-L6-v2` embeddings (Transformers.js). Already in the plan and already free. | — |
| Color search | Local OKLab k-means on thumbnails. Already free. | — |
| Tags, summary, search phrases per bookmark | **Chrome built-in AI (Gemini Nano, Prompt API `LanguageModel`)** with a JSON `responseConstraint` schema, run by the offscreen engine. | Claude Haiku (user's key) |
| Describing images ("the blue chart") | Gemini Nano image input, used only if `LanguageModel.availability({expectedInputs:[{type:'image'}]})` says it's available | Claude Haiku vision |
| Query planner ("pricing post from linkedin last spring") | Local `queryParse.ts` (already built) + Gemini Nano for rewrites/synonyms | Claude |
| Rerank top 30 | Skipped (RRF of keyword + vector is the final order) | Claude |

- **Gemini Nano limits:** needs Chrome desktop (Windows/macOS/Linux/ChromeOS Plus, not phones), about 22 GB free disk for a one-time model download, and either a GPU with more than 4 GB VRAM or 16 GB RAM with 4+ CPU cores. Check with `LanguageModel.availability()`; the first-run download needs a click (user activation) on the Settings page, with a progress bar.
- **Throughput:** Gemini Nano is slow (a few seconds per item), so the backfill runs in the background queue at about 1 item at a time while the browser is idle. 5,000 bookmarks take hours, not minutes, but cost $0. Keyword, vector and color search work immediately; enrichment only improves them.
- **Fallbacks when Gemini Nano isn't available:** search still works via keywords + embeddings + colors (no tags/summaries). Settings offer a Claude key as an opt-in upgrade.
- **Not the default:** free cloud tiers such as the Gemini API free tier. They're rate-limited, and Google may use free-tier prompts to improve its products, which conflicts with keeping bookmarks private. Could be added later as an opt-in provider.
- The Claude-specific parts below (Batches, prompt caching, spend cap) apply only when the user turns Claude on.

## Data model (Dexie)
- **`items`** — one row per canonical URL.
  - Key and indexes: `++id, &canonicalUrl, lastSavedAt, *sources, *colorBuckets, *tags, enrich.status`.
  - Fields: `url, kind(page|post|reel|video|image), title, text(≤8k chars), author, siteName, linkedUrls[], palette[{L,C,h,weight}], summary, visualDesc, searchPhrases[], enrich{status,attempts,nextAt,batchId,promptVersion,error}`.
- **`saves`** — one row per source save: `++id, &[source+sourceId], itemId, source, savedAt, removedAt, lastSeenAt`, plus `folderPath`.
  - One item can have several saves. A tweet saved on X and the same URL starred in Chrome become one result with two source badges.
- **`thumbs`** — `{itemId, blob}`: WebP, at most 320px, about 20KB (roughly 100MB for 5k items).
- **`vectors`** — `{itemId, model, vec: Int8Array(384)}`.
- **`sourceState`** — per source: `enabled, autoSync, status(ok|stale|broken|needs-login|paused), lastPassiveAt, lastSyncAt, lastSyncAdded, lastError, adapterVersion`.
- **`usage`** — per day: tokens and USD.
- **`settings`** — includes the API key. It is stored in extension-origin IndexedDB, not `chrome.storage.local`, so content scripts can never read it.
- **Canonicalization (`canonical.ts`):**
  - Lowercase the host and strip `utm_*`, `fbclid`, `gclid`, `igsh/igshid`, `si`, `ref`, and the X `s`/`t` parameters.
  - Fold twitter.com and mobile.x.com into x.com.
  - Normalize URL shapes: `instagram.com/(p|reel)/<code>/`, `linkedin.com/feed/update/urn:li:activity:<id>/`, `x.com/<user>/status/<id>`.
  - `javascript:` bookmarklets are stored but never fetched or opened.
- **Unsaves:** never hard-delete. An unsave sets `saves.removedAt`. Removed items are hidden by default, with a filter to show them. Losing links is the user's core pain.

## Capture
1. **Chrome bookmarks and Reading List — zero user action.**
   - **First run:** full sync with `getTree()`.
   - **Live updates:** `onCreated/onChanged/onMoved/onRemoved` listeners, registered synchronously at top level so they can wake the SW. Bookmarks synced from the user's phone through Chrome Sync fire the same events.
   - **Imports:** suspend per-event handling between `onImportBegan` and `onImportEnded`, then reconcile.
   - **Reconcile:** on `runtime.onStartup`, diff the bookmark tree against `saves`.
   - **Live enrichment:** when `<all_urls>` is granted and the new bookmark's URL is the active tab, grab the rendered text (`scripting.executeScript`) and a screenshot (`captureVisibleTab`). This gives better text and colors than fetching the page later.
2. **X: passive capture.**
   - The MAIN-world hook wraps `fetch` and XHR and forwards parsed payloads to the isolated-world script with `window.postMessage`. That script validates every payload with zod before sending it to the SW.
   - Every timeline response fills an in-page cache that maps tweet ID to tweet.
   - A `CreateBookmark` mutation saves that tweet immediately; a `DeleteBookmark` mutation marks it removed.
   - `Bookmarks` query responses on /i/bookmarks are ingested directly.
   - The hook also captures the request's URL, variables and headers so auto-sync can replay them.
3. **X: auto-sync (opt-in per source, off by default, with a clear warning about Terms of Service and account risk).**
   - A daily alarm runs it, preferring times when `idle` reports the user is away.
   - It opens /i/bookmarks in an unfocused, minimized window.
   - The page issues its own first request, which the hook captures. It then replays that same request in the page with only `cursor` changed, about 1 page every 3s with jitter. It stops at the first item it already has.
     - Why replay instead of auto-scrolling: hidden tabs are throttled, and infinite scroll doesn't load reliably there.
     - Replaying the exact live request also survives X changing its GraphQL query hash.
   - It closes the window and records the result in `sourceState`.
   - A login wall sets `needs-login`; a 429 or challenge page sets `paused` and backs off.
   - Weekly full walk: saves not seen get `missingSince`.
4. **Instagram and LinkedIn: same adapter contract and hook pattern.**
   - Instagram: hook the save/unsave POSTs and the saved-feed responses on `/<user>/saved/`.
   - LinkedIn: hook Voyager save actions and the saved-posts responses on `/my-items/saved-posts/`.
   - Endpoint names and shapes are pinned in `endpoints.ts` after a recon step that records fixtures.
   - Fallback: a DOM parser with selectors in the same versioned file.
   - Instagram auto-sync is capped at 3 pages per run, since Instagram is the most aggressive about flagging automation.
5. **Media:** the content script sends media URLs to the SW, which fetches them immediately because Instagram and LinkedIn CDN URLs are signed and expire. It downscales them with `createImageBitmap` and `OffscreenCanvas` and stores them in `thumbs`.
6. **Health:** if an adapter sees its endpoint with a non-empty body but parses 0 items, it marks itself `broken`. The Sources page shows last capture, last sync, items added, status, and a "Copy debug report" button that includes no personal data.

## Enrichment (engine, persistent queue)
- **Queue lives in `items.enrich`**, so it survives SW and engine restarts.
  - A `pump` alarm (1 min) starts the engine when work is pending.
  - Backoff: 30s × 2^n, at most 5 attempts.
  - Bumping `promptVersion` re-enriches items lazily.
- **Text sources:**
  - Posts: the post text plus expanded links.
  - Pages: the live-tab text, or a `fetch` (GET only, `credentials: "omit"`, 10s timeout, 2MB cap, 4 at a time) parsed with Readability. If neither is available, use og:/meta tags; failing that, title and URL.
  - Text is capped at about 1,500 tokens.
- **Thumbnail order:** media → og:image → screenshot → favicon (`_favicon/`).
- **Color (local, free):**
  - Downscale to 64×64 and run k-means (k=5) in OKLab.
  - Name each cluster with OKLCH rules: chroma below 0.04 is black/gray/white by lightness; otherwise hue ranges map to red, orange, yellow, green, teal, blue, purple, pink, and dark orange/yellow becomes brown.
  - Store bucket names (clusters with at least 12% coverage) in `colorBuckets` together with their weights.
- **Claude call:** `@anthropic-ai/sdk` with `dangerouslyAllowBrowser: true`, model `claude-haiku-5-5`, `thinking: {type:"disabled"}`, `output_config: {effort:"low", format: <json_schema>}`.
  - The system prompt plus schema is about 900 tokens and marked `cache_control`; Haiku 5.5 caches prefixes of 512 tokens or more.
  - Input: text plus the 320px thumbnail as base64 WebP.
  - Output: `summary, tags[], topics[], entities[], searchPhrases[], visualDesc, kind`.
  - Read content blocks by type. A `stop_reason: "refusal"` marks the item `skipped`. On 429, honor `retry-after`.
- **Routing:**
  - A few new items: direct calls, 3 at a time, enriched within seconds.
  - Backfills over 50 items: **Message Batches** at 50% off, in chunks of at most 1,000 requests, polled by alarm every 5 min. Results are matched by `custom_id`.
- **Cost (5,000 bookmarks, Haiku 5.5 at $0.10/$0.50 per MTok):** about 1,750 input and 250 output tokens per item. That's about $1.50 with direct calls, or about $0.75 through Batches; allow ±30% for tokenizer variance.
- **Spend controls:** spend counter, daily cap (default $1), per-source enrichment toggles. Onboarding states plainly that saved items' text and thumbnails are sent to Anthropic.
- **Prompt injection:** enrichment output is schema-constrained data that is only indexed, never executed, so injected text in a page can't make it do anything.

## Search
1. **Instant tier (no API key needed; target under 50ms after a 120ms debounce):**
   - `queryParse.ts` pulls out obvious filters locally:
     - source words ("from linkedin", "tweet", "insta")
     - dates via `chrono-node` ("last spring", "2 weeks ago")
     - color words via a synonym map (navy→blue, crimson→red, beige→brown/white)
     - media kind ("video", "thread")
   - Two retrievers run in a Web Worker:
     - **MiniSearch:** fuzzy and prefix matching, boosted on title > tags/searchPhrases > summary > text/author/folderPath.
     - **Vectors:** brute-force cosine over Int8 vectors. The query is embedded by a bundled int8 `all-MiniLM-L6-v2` model (Transformers.js) in about 20ms. Documents are embedded from title + summary + tags, and re-embedded after enrichment.
   - The two rankings are merged with reciprocal rank fusion (RRF). Filters are applied as Dexie index constraints; color ranks by bucket weight.
2. **Smart tier** (Enter key, or a 600ms pause; the previous request is cancelled with AbortController):
   - The Haiku planner turns the query into `{keywords[], rewrites[], source, dateRange, colors[], kind}`. Its filters are merged over the local parse.
   - The query is re-retrieved with the rewrites, then the top 30 cards (about 80 tokens each) are reranked by Haiku.
   - Instant results stay on screen; smart results replace them with a "Smart" badge, and never while the user is hovering or navigating them.
   - Target 1.5–2.5s. Cost about $0.0005 per query.
   - Planner output is cached per query. The models can be changed in settings (Sonnet 5.5 or Opus 5.5 for a "Deep" mode).
3. **Ways in:**
   - Clicking the toolbar icon opens the app, or focuses it if it's already open. There is no popup, because Ctrl+D is already the "save this page" action.
   - Keyboard shortcut (`commands`, default Alt+Shift+B).
   - Address bar keyword `bm <query>`, which shows instant-tier suggestions.
   - No new-tab override: it's a static manifest setting, triggers a Chrome warning, and only one extension can claim the new tab.
4. **Result cards:** thumbnail, source badges, summary, tags, color swatches, saved date, and a "Removed from X" marker if unsaved. Filter chips for source, date, color and tag. Only http(s) links are opened. All text is rendered as text, never as HTML.

## Security
- Every runtime message is checked: `sender.id === chrome.runtime.id`, the sender tab's URL must match that adapter's hosts, and the payload must pass its zod schema.
- Each source's hook only accepts that source's own origin.
- The API key never reaches content scripts.
- No `externally_connectable`.
- Data export/import as JSON for backups, plus a "Delete all" button.
- Distribution is Load unpacked, for personal use. Chrome Web Store review may object to the social-site adapters.

## Milestones (each one leaves a working product)
1. **MVP: Chrome in one place.**
   - WXT scaffold, Dexie, Chrome bookmarks and Reading List sync plus reconcile.
   - App with the instant tier (MiniSearch plus `queryParse`).
   - Toolbar icon, keyboard shortcut, address-bar keyword.
   - Works with no API key.
2. **X adapter and the adapter framework.**
   - Recon: record and sanitize fixtures.
   - MAIN-world hook, passive capture, ingest on the bookmarks page.
   - Opt-in auto-sync, `sourceState`, Sources/health page.
3. **Engine and enrichment:** offscreen engine, persistent queue, page fetch with the optional permission, thumbnails, color buckets (the color filter goes live here), `AiProvider` with Gemini Nano as the default enricher (availability check, model download from Settings), settings.
4. **Smart search:** bundled embeddings with RRF, Gemini Nano query rewrites, golden-set evaluation. Optional Claude provider (enrichment with Batches, planner, rerank, spend cap) for users who add a key.
5. **Instagram, then LinkedIn,** on the same adapter contract.
6. **Hardening:** weekly full reconcile, `missingSince` handling, JSON export/import, onboarding polish, performance pass at 10k items.

## Verification
- **Unit tests (Vitest):**
  - `canonical`, `queryParse` (dates, colors, sources)
  - color naming (fixed swatches → expected buckets)
  - RRF fusion
  - queue state machine (fake timers, simulated SW kill mid-batch)
  - each adapter's `parse.ts` against the recorded fixtures
  - zod rejection of malformed or spoofed hook messages
- **Search quality:** about 40 golden queries over a seeded 300-item fixture library. Expected item in the top 3: at least 80% for the instant tier (run in CI), and at least 95% for the smart tier (manual script, real key).
- **End-to-end (Playwright, Chromium persistent context with `--load-extension`):**
  - `context.route` serves fixture x.com, Instagram and LinkedIn pages and GraphQL, so the real hooks run.
  - The Claude base URL points at a local mock server (dev setting).
  - Assert: bookmark created → appears in the app within 2s; simulated save click → item captured; auto-sync replay stops at the first known item; broken fixture → status `broken`.
- **Manual on real accounts:** add, move or delete a Chrome bookmark; save and unsave on each platform while browsing; save on the phone and confirm the next auto-sync picks it up; check that the Sources page timestamps are correct.
- `npm run build` → Load unpacked from `.output/chrome-mv3` → SW starts with no errors.

## Critical files
- `wxt.config.ts` (manifest, permissions, CSP)
- `src/core/db.ts`
- `entrypoints/background.ts`
- `entrypoints/engine.ts`
- `src/adapters/x/` (with `entrypoints/x-hook.content.ts`)
- `src/core/search/`
