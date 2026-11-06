#!/bin/sh
# Runs every test suite. Needs Ruby (standard library only) and Firefox;
# the Chrome suite also needs Chrome for Testing (scripts/get-chrome.sh).
# editors_e2e.rb needs network access to the editors' demo sites.
cd "$(dirname "$0")"
status=0
run() { echo "\n=== $1"; ruby "$1" || status=1; }
run unit/engine_test.rb
for t in e2e docs_e2e editors_e2e report_e2e breaks_e2e private_e2e lifecycle_e2e xpi_test; do
  run "firefox/$t.rb"
done
if [ -x .browsers/chromedriver ]; then run chrome/chrome_e2e.rb; run chrome/editors_e2e.rb; else echo "\n(skipping Chrome: run scripts/get-chrome.sh first)"; fi
exit $status
