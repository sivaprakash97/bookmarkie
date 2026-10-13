import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Bookmarkie',
    description:
      'All your Chrome, X, LinkedIn and Instagram bookmarks in one place, searchable in plain language.',
    // Host permissions for the social sites arrive with their milestones.
    permissions: ['bookmarks', 'readingList', 'storage', 'unlimitedStorage', 'alarms', 'favicon'],
    // Asked for only when the user clicks "Check links" in Clean up.
    optional_host_permissions: ['<all_urls>'],
    // The end-to-end tests can't click Chrome's permission prompt, so their build has it up front.
    ...(process.env.BOOKMARKIE_E2E ? { host_permissions: ['<all_urls>'] } : {}),
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
