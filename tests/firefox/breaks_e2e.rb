# Scheduled breaks: Graphi stops between words, waits, then carries on, and
# the breaks show up in the session report. Uses the test-only _breakEveryMs /
# _breakLengthMs settings so breaks take seconds instead of minutes.
require_relative '../support/harness'
include Harness

PROFILE = File.join(ENV['TMPDIR'] || '/tmp', "graphi-breaks-#{Process.pid}")
TEXT = ('Breaks give the hands a rest between paragraphs of steady typing. ' * 5).strip
SETTINGS = {
  wpm: 250, variability: 0, typoRate: 0, punctuationPauses: false, thinkingBreaks: 'off', countdown: 0,
  speedDrift: false, pauseWhenHidden: false, pauseOnInteraction: true, escToStop: true, showHud: true,
  correction: 'natural', docsMethod: 'auto', paceMode: 'wpm', breakEvery: 15, breakLength: 1,
  _breakEveryMs: 4000, _breakLengthMs: 3000
}.freeze

start_server
m = boot(PROFILE, port: 2956)
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
ext.call(<<~JS, [SETTINGS, TEXT])
  const now = Date.now();
  await browser.storage.local.set({ settings: args[0],
    library: { docs: [{ id: 'b1', title: 'Breaks', text: args[1], createdAt: now, updatedAt: now }], activeId: 'b1' } });
  return true;
JS

puts "\n\e[1mScheduled breaks\e[0m"
switch_to(m, page)
m.navigate("#{BASE}/playground.html")
tid = selected_tab_id(m)
m.js("const a = document.getElementById('area'); a.value = ''; a.focus(); return true;")
fire_command(m, 'toggle-typing')
status = -> { ext.call('return (await browser.runtime.sendMessage({ type: "popup:status", tabId: args[0] })).snapshot;', [tid]) }
snap = (wait_until(timeout: 20, interval: 0.1) { s = status.call; s && s['breakLeft'].to_i > 0 ? s : nil } rescue nil)
check 'a break starts after a few seconds of typing', !!snap, snap&.slice('state', 'typed').inspect
if snap
  v1 = m.js("return document.getElementById('area').value")
  check 'the break starts between words', v1.end_with?(' '), v1[-12..].inspect
  sleep 1.5
  v2 = m.js("return document.getElementById('area').value")
  check 'nothing is typed during the break', v1 == v2
  panel = status.call
  check 'popup status shows the time left', panel['breakLeft'].to_i.between?(1, 4000), panel['breakLeft'].inspect
end
done = (wait_until(timeout: 60) { m.js("return document.getElementById('area').value") == TEXT } rescue false)
check 'typing resumes after the break and finishes exactly', done
rep = (wait_until(timeout: 5) { ext.call("return ((await browser.storage.local.get('reports')).reports || [])[0] || null") } rescue nil)
breaks = (rep&.dig('pauses') || []).select { |p| p[2] == 'break' }
check "breaks are logged in the report (#{breaks.length})", breaks.length >= 2
check 'break time is kept out of typing time', rep && rep['breakMs'].to_i >= 4000 && rep['activeMs'] < (rep['endedAt'] - rep['startedAt']) - 3000,
      rep&.slice('activeMs', 'breakMs').inspect
check 'break gaps are not counted as slow keys', rep && rep['dts'].max < 2000, rep && rep['dts'].max.inspect

puts "Console: #{console_errors(m).reject { |x| x.include?('Ignored listener') }.uniq.first(5).inspect}"
m.quit
FileUtils.rm_rf(PROFILE)
puts($failures.empty? ? "\e[32mAll break checks passed.\e[0m" : "\e[31mFailed: #{$failures.join(', ')}\e[0m")
exit($failures.empty? ? 0 : 1)
