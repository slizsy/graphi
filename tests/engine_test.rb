# Property test for the typing engine, run inside Firefox.
require_relative 'harness'
include Harness
PROFILE = File.join(ENV['TMPDIR'] || '/tmp', "graphi-engine-#{Process.pid}")
start_server
m = boot(PROFILE, port: 2952)
m.navigate("#{BASE}/engine.html")
r = m.js('return runEngineTests(3000)', [], timeout: 120_000)
puts "\n\e[1mEngine property test\e[0m"
check "#{r['cases']} random texts × settings reproduce exactly (#{r['steps']} steps, #{r['typos']} mistyped keys)", r['failures'].empty?, r['failures'].first.inspect
check 'mistakes were actually exercised', r['typos'] > 1000
m.quit
FileUtils.rm_rf(PROFILE)
exit($failures.empty? ? 0 : 1)
