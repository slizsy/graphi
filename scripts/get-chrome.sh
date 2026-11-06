#!/bin/sh
# Downloads Chrome for Testing + chromedriver into tests/.browsers/ for the
# Chrome test suite. (Regular Chrome no longer loads unpacked extensions from
# the command line; Chrome for Testing still does.)
set -e
cd "$(dirname "$0")/.."
VERSION="${CHROME_VERSION:-131.0.6778.85}"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) PLATFORM=mac-arm64 ;;
  Darwin-*) PLATFORM=mac-x64 ;;
  Linux-*) PLATFORM=linux64 ;;
  *) echo "Unsupported platform" >&2; exit 1 ;;
esac
BASE="https://storage.googleapis.com/chrome-for-testing-public/$VERSION/$PLATFORM"
DEST=tests/.browsers
mkdir -p "$DEST"
cd "$DEST"
for pkg in chrome chromedriver; do
  echo "Downloading $pkg $VERSION ($PLATFORM)…"
  curl -fsSL -o "$pkg.zip" "$BASE/$pkg-$PLATFORM.zip"
  unzip -q -o "$pkg.zip"
  rm "$pkg.zip"
done
ln -sf "chromedriver-$PLATFORM/chromedriver" chromedriver
case "$PLATFORM" in
  # The Mac app must run from its real path (it finds its framework relative
  # to it), so record the path instead of symlinking.
  mac-*) echo "$PWD/chrome-$PLATFORM/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" > chrome-path
         xattr -dr com.apple.quarantine . 2>/dev/null || true ;;
  *) echo "$PWD/chrome-$PLATFORM/chrome" > chrome-path ;;
esac
echo "Ready: tests/.browsers/chrome-path and tests/.browsers/chromedriver"
