# Verifies the packaged .xpi (not the source folder) installs and types.
require_relative '../support/harness'
include Harness
PROFILE = File.join(ENV['TMPDIR'] || '/tmp', "graphi-xpi-#{Process.pid}")
xpi = (system(File.join(ROOT, 'scripts', 'build.sh'), 'firefox', out: File::NULL) && Dir[File.join(ROOT, 'dist', 'graphi-firefox-*.xpi')].max)
start_server
m = boot(PROFILE, port: 2954)
m.context('chrome')
id = m.install_addon(xpi, temporary: true)
m.context('content')
sleep 1
puts "\n\e[1mPackaged XPI (#{File.basename(xpi)})\e[0m"
check 'installs with the expected add-on ID', id == 'graphi@graphi.app', id.inspect
m.navigate("#{BASE}/playground.html")
m.js("document.getElementById('plain').focus(); return true;")
fire_command(m, 'toggle-typing')
ok = (wait_until(timeout: 30) { m.js("return document.getElementById('plain').value").start_with?('Graphi types this text') } rescue false)
check 'first-run welcome text types via the shortcut (default settings, 3s countdown)', ok, m.js("return document.getElementById('plain').value").inspect
warn_lines = console_errors(m, all: true).grep(/graphi|manifest/i).reject { |x| x.include?('Ignored listener') }
check 'no manifest warnings or errors', warn_lines.empty?, warn_lines.first(3).inspect
m.quit
FileUtils.rm_rf(PROFILE)
exit($failures.empty? ? 0 : 1)
