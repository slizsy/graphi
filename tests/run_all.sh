#!/bin/sh
# Runs every test suite against a headless Firefox. Needs only Ruby (stdlib)
# and Firefox. editors_e2e.rb needs network access to the editors' demo sites.
cd "$(dirname "$0")"
status=0
for t in engine_test.rb e2e.rb docs_e2e.rb editors_e2e.rb report_e2e.rb breaks_e2e.rb private_e2e.rb lifecycle_e2e.rb; do
  echo "\n=== $t"
  ruby "$t" || status=1
done
../build.sh && ruby xpi_test.rb || status=1
exit $status
