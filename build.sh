#!/bin/sh
# Packages the extension into dist/graphi-<version>.xpi (a plain zip).
set -e
cd "$(dirname "$0")"
VERSION=$(sed -n 's/.*"version": "\(.*\)".*/\1/p' extension/manifest.json | head -1)
OUT="dist/graphi-$VERSION.xpi"
mkdir -p dist
rm -f "$OUT"
(cd extension && zip -q -r -X "../$OUT" . -x '.*' -x '*/.*')
echo "Built $OUT ($(du -h "$OUT" | cut -f1))"
