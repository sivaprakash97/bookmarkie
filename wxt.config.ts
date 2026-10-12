import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Bookmarkie',
    description:
      'All your Chrome, X, LinkedIn and Instagram bookmarks in one place, searchable in plain language.',
    // Milestone 1 only needs Chrome's own bookmark data. Host permissions for
    // the social sites and api.anthropic.com arrive with their milestones.
    permissions: ['bookmarks', 'readingList', 'storage', 'unlimitedStorage', 'alarms', 'favicon'],
    action: { default_title: 'Open Bookmarkie' },
    omnibox: { keyword: 'bm' },
    commands: {
      _execute_action: {
        suggested_key: { default: 'Alt+Shift+B' },
        description: 'Open Bookmarkie',
      },
    },
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
});
