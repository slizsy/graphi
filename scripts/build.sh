#!/bin/sh
# Builds Graphi for each browser.
#
#   scripts/build.sh            # both browsers
#   scripts/build.sh firefox    # just one
#   scripts/build.sh chrome
#
# Output:
#   dist/firefox/                      unpacked, load from about:debugging
#   dist/chrome/                       unpacked, "Load unpacked" in chrome://extensions
#   dist/graphi-firefox-<version>.xpi  for addons.mozilla.org
#   dist/graphi-chrome-<version>.zip   for the Chrome Web Store
#
# Both builds share everything in src/; only the manifest (and Chrome's PNG
# icons) come from platforms/<browser>/.
set -e
cd "$(dirname "$0")/.."

version_of() { sed -n 's/.*"version": "\(.*\)".*/\1/p' "$1" | head -1; }
VERSION=$(version_of platforms/firefox/manifest.json)
if [ "$(version_of platforms/chrome/manifest.json)" != "$VERSION" ]; then
  echo "Version mismatch: update platforms/chrome/manifest.json to $VERSION" >&2
  exit 1
fi

build() {
  target="$1"
  out="dist/$target"
  rm -rf "dist/$target"
  mkdir -p "$out"
  cp -R src/ "$out/"
  cp -R "platforms/$target/" "$out/"
  find "$out" -name '.DS_Store' -delete
}

package() {
  target="$1"
  ext="$2"
  file="dist/graphi-$target-$VERSION.$ext"
  rm -f "$file"
  (cd "dist/$target" && zip -q -r -X "../../$file" . -x '.*' -x '*/.*')
  echo "Built $file ($(du -h "$file" | cut -f1))"
}

case "${1:-all}" in
  firefox) build firefox; package firefox xpi ;;
  chrome) build chrome; package chrome zip ;;
  all) build firefox; package firefox xpi; build chrome; package chrome zip ;;
  *) echo "usage: scripts/build.sh [firefox|chrome|all]" >&2; exit 2 ;;
esac
