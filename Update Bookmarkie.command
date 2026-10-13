#!/bin/bash
# Double-click this file to update Bookmarkie: it downloads the latest version
# from GitHub and rebuilds it. Bookmarkie then reloads itself in Chrome.
#
# It makes this folder match GitHub exactly, so any edits to Bookmarkie's own
# files here are replaced. Your bookmarks and Bookmarkie's data live in Chrome
# and are not touched.

cd "$(dirname "$0")" || exit 1

pause() { echo; read -r -n 1 -s -p "Press any key to close this window."; echo; }
fail() { echo; echo "❌ $1"; pause; exit 1; }

# Windows opened from Finder don't always load nvm, which provides Node.js.
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

command -v git >/dev/null || fail "git isn't installed. Open Terminal and run: xcode-select --install"
command -v npm >/dev/null || fail "Node.js isn't installed. See \"Install\" in the README."
[ -d .git ] || fail "This folder isn't linked to GitHub yet. Do the one-time setup in the README."

echo "⬇️  Downloading the latest Bookmarkie…"
git fetch --quiet || fail "Couldn't reach GitHub. Check your internet connection."
before=$(git rev-parse HEAD)
git reset --quiet --hard '@{upstream}' || fail "Couldn't apply the update."
if [ "$before" = "$(git rev-parse HEAD)" ] && [ -f .output/chrome-mv3/build.json ]; then
  echo "✅ You already have the latest version."
  pause
  exit 0
fi
git --no-pager log --format='   • %s' "$before..HEAD" 2>/dev/null | head -10

echo "📦 Installing…"
npm install --no-fund --no-audit || fail "Installing failed (see above)."
echo "🔨 Building…"
npm run build || fail "Building failed (see above)."

echo
echo "✅ Updated. Bookmarkie reloads itself in Chrome within a minute, or straight away when you open it."
pause
