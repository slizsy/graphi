# Session reports, the replay, and "finish in" pacing.
#
#   ruby tests/report_e2e.rb          # everything (includes a ~1 minute pacing run)
#   QUICK=1 ruby tests/report_e2e.rb  # skip the pacing run
require_relative 'harness'
include Harness

PROFILE = File.join(ENV['TMPDIR'] || '/tmp', "graphi-report-#{Process.pid}")
REPORT = "moz-extension://#{Marionette::EXT_UUID}/report/report.html"
FAST = {
  wpm: 220, variability: 30, typoRate: 6, correction: 'natural', punctuationPauses: true, thinkingBreaks: 'off',
  countdown: 0, speedDrift: true, pauseWhenHidden: false, pauseOnInteraction: true, escToStop: true, showHud: true,
  docsMethod: 'auto', paceMode: 'wpm', targetMinutes: 10, autoReport: false
}.freeze
TEXT = "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs!\n" \
       'Sphinx of black quartz, judge my vow — how vexingly quick daft zebras jump. 😀 done.'

start_server
m = boot(PROFILE, port: 2952)
install(m)
ctl = m.cmd('WebDriver:GetWindowHandle')['value']
m.navigate("#{POPUP}?tab=-1")
page = m.cmd('WebDriver:NewWindow', { 'type' => 'window', 'focus' => true })['handle']

ext = lambda do |body, args = []|
  switch_to(m, ctl)
  v = m.js(body, args)
  switch_to(m, page)
  v
end
configure = lambda do |text, **s|
  ext.call(<<~JS, [FAST.merge(s), text])
    const now = Date.now();
    await browser.storage.local.set({ settings: args[0],
      library: { docs: [{ id: 'd1', title: 'Pangrams', text: args[1], createdAt: now, updatedAt: now }], activeId: 'd1' } });
    return true;
  JS
end
reports = -> { ext.call("return (await browser.storage.local.get('reports')).reports || [];") }
field = -> { m.js("return document.getElementById('area').value") }
type_into_area = lambda do |text|
  switch_to(m, page)
  m.navigate("#{BASE}/playground.html")
  m.js("const a = document.getElementById('area'); a.value = ''; a.focus(); return true;")
  fire_command(m, 'toggle-typing')
  wait_until(timeout: 60) { field.call == text }
end

puts "\n\e[1mRecording a session\e[0m"
configure.call(TEXT)
type_into_area.call(TEXT)
r = wait_until { reports.call.first }
check 'a report is saved when the session finishes', r && r['outcome'] == 'done', r&.slice('outcome', 'title').inspect
keys = r['keys']
check 'every key is logged with its timing', r['dts'].length == keys.chars.length && r['dts'].all? { |d| d.is_a?(Integer) && d >= 0 }
check 'typos and their corrections are in the log', keys.include?("\b") && !r['typos'].empty?, "typos=#{r['typos'].length}"
# Replaying the log (applying backspaces) reproduces the typed text.
buf = []
keys.chars.each { |c| c == "\b" ? buf.pop : buf << c }
check 'the log replays to exactly the typed text', buf.join == TEXT
stats = ext.call("return (await browser.storage.local.get('stats')).stats;")
check 'lifetime stats are updated', stats['sessions'] == 1 && stats['chars'] == TEXT.chars.length, stats.inspect
check 'report records the target and site', r['host'] == '127.0.0.1' && !r['target'].to_s.empty?, r.slice('host', 'target').inspect

puts "\n\e[1mReport page\e[0m"
switch_to(m, ctl)
m.navigate("#{REPORT}?id=#{r['id']}")
wait_until { m.js('return document.documentElement.dataset.ready') == 'true' }
sleep 0.4
info = m.js(<<~JS)
  return {
    title: document.getElementById('rTitle').textContent,
    tiles: [...document.querySelectorAll('.tile')].map(t => t.querySelector('.tile-label').textContent + '=' + t.querySelector('.tile-value').textContent),
    ink: document.getElementById('ink').textContent,
    typo: document.getElementById('typo').textContent,
    speedPath: !!document.querySelector('#speedChart path[stroke="#D6FF3D"]'),
    bars: document.querySelectorAll('#rhythmChart .bar').length,
    items: document.querySelectorAll('#list .item').length,
    life: document.getElementById('lifeSessions').textContent,
    auto: document.querySelector('.auto-chip')?.textContent,
  };
JS
check 'opens on the requested session', info['title'] == 'Pangrams'
check 'summary tiles render', info['tiles'].length == 6 && info['tiles'][0] =~ /Average speed=\d+wpm/, info['tiles'].inspect
check 'replay opens on the finished text', info['ink'] == TEXT && info['typo'] == '', info['ink'][0, 40].inspect
check 'speed chart and rhythm histogram render', info['speedPath'] && info['bars'] == 9
check 'history list and lifetime totals', info['items'] == 1 && info['life'] == '1'
check 'report is labelled as an automated session', info['auto'] == 'Automated typing session'

mid = m.js(<<~JS)
  const s = document.getElementById('scrubber');
  s.value = '500'; s.dispatchEvent(new Event('input'));
  return document.getElementById('ink').textContent + document.getElementById('typo').textContent;
JS
check 'scrubbing to the middle shows a partial text', mid.length > 5 && mid.length < TEXT.length, mid.length.to_s
m.js("document.querySelector('#speedSeg [data-x=\"64\"]').click(); document.getElementById('scrubber').value = '0'; document.getElementById('scrubber').dispatchEvent(new Event('input')); document.getElementById('play').click(); return true;")
done = (wait_until(timeout: 20) { m.js("return !document.body.classList.contains('playing') && document.getElementById('ink').textContent") == TEXT } rescue false)
check 'playback runs to the end and matches the text', done

# Hover tooltips
tipped = m.js(<<~JS)
  const hit = document.querySelector('#speedChart .hit');
  const r = hit.getBoundingClientRect();
  hit.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + r.width / 2, clientY: r.top + 40, bubbles: true }));
  const t = document.getElementById('tip');
  return !t.hidden && /wpm/.test(t.textContent);
JS
check 'speed chart shows a hover tooltip', tipped
m.screenshot(File.join(__dir__, 'screenshots', 'report.png'))

puts "\n\e[1mStopping mid-typo\e[0m"
long = (TEXT + ' ') * 4
configure.call(long, wpm: 90, typoRate: 8)
switch_to(m, page)
m.navigate("#{BASE}/playground.html")
m.js("const a = document.getElementById('area'); a.value = ''; a.focus(); return true;")
fire_command(m, 'toggle-typing')
wait_until { field.call.length > 40 }
fire_command(m, 'stop-typing')
r2 = wait_until { reports.call.find { |x| x['outcome'] == 'stopped' } }
buf = []
r2['keys'].chars.each { |c| c == "\b" ? buf.pop : buf << c }
check 'stopped sessions get a report too', !!r2
check 'the stopped log replays to what is on the page', buf.join == field.call, [buf.join.length, field.call.length].inspect
check 'stats count both sessions', ext.call("return (await browser.storage.local.get('stats')).stats.sessions") == 2

puts "\n\e[1mOpening reports\e[0m"
ext.call("await browser.runtime.sendMessage({ type: 'popup:openReport' }); return true;")
opened = (wait_until(timeout: 5) { chrome(m, 'return [...Services.wm.getEnumerator("navigator:browser")].flatMap(w => [...w.gBrowser.tabs]).some(t => t.linkedBrowser.currentURI.spec.includes("/report/report.html"))') } rescue false)
check 'the popup opens the reports page in a tab', opened
check 'autoReport opens the report when typing finishes', begin
  configure.call('Short one.', autoReport: true, typoRate: 0)
  chrome(m, 'for (const t of [...Services.wm.getMostRecentWindow("navigator:browser").gBrowser.tabs]) if (t.linkedBrowser.currentURI.spec.includes("/report/")) Services.wm.getMostRecentWindow("navigator:browser").gBrowser.removeTab(t); return true;')
  type_into_area.call('Short one.')
  wait_until(timeout: 6) { chrome(m, 'return [...Services.wm.getEnumerator("navigator:browser")].flatMap(w => [...w.gBrowser.tabs]).some(t => t.linkedBrowser.currentURI.spec.includes("/report/report.html?id="))') }
rescue RuntimeError
  false
end

puts "\n\e[1mDelete and undo\e[0m"
switch_to(m, ctl)
m.navigate(REPORT)
wait_until { m.js('return document.documentElement.dataset.ready') == 'true' }
n0 = reports.call.length
switch_to(m, ctl)
m.js("document.getElementById('deleteReport').click(); return true;")
sleep 0.5
n1 = reports.call.length
switch_to(m, ctl)
m.js("document.querySelector('#toast button').click(); return true;")
sleep 0.5
check 'delete removes a report and undo restores it', n1 == n0 - 1 && reports.call.length == n0, [n0, n1].inspect

unless ENV['QUICK']
  puts "\n\e[1mFinish-in pacing (1 minute)\e[0m"
  paced_text = 'Graphi keeps an even pace. ' * 9 # ~250 chars: ~50 wpm needed
  configure.call(paced_text, paceMode: 'duration', targetMinutes: 1, typoRate: 2, thinkingBreaks: 'occasional')
  t0 = Time.now
  ok = (type_into_area.call(paced_text) rescue false)
  took = Time.now - t0
  check "finishes close to the 1-minute target (#{took.round(1)}s)", ok && took.between?(52, 70)
  rp = wait_until { reports.call.find { |x| x.dig('settings', 'paceMode') == 'duration' } }
  check 'report shows the pace target', rp && rp.dig('settings', 'targetMinutes') == 1
end

puts "Console: #{console_errors(m).reject { |x| x.include?('Ignored listener') }.uniq.first(5).inspect}"
m.quit
FileUtils.rm_rf(PROFILE)
puts($failures.empty? ? "\e[32mAll report checks passed.\e[0m" : "\e[31mFailed: #{$failures.join(', ')}\e[0m")
exit($failures.empty? ? 0 : 1)
