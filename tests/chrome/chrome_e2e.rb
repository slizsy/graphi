# End-to-end tests for the Chrome build, in Chrome for Testing.
#
#   scripts/get-chrome.sh          # once: downloads Chrome for Testing
#   ruby tests/chrome/chrome_e2e.rb
#
# Same idea as the Firefox suites: one window holds a Graphi page we use to
# seed storage and talk to the service worker, another holds the site under
# test. Typing is started through the popup's own messages, because a test
# can't press the toolbar button or a browser-level shortcut.
require_relative '../support/chromedriver'

ROOT = File.expand_path('../..', __dir__)
PORT = 8124
BASE = "http://127.0.0.1:#{PORT}"
abort 'Chrome for Testing is missing: run scripts/get-chrome.sh first.' unless ChromeDriver.available?

$failures = []
def check(name, cond, detail = nil)
  puts cond ? "  \e[32m✓\e[0m #{name}" : "  \e[31m✗ #{name}\e[0m#{detail ? " — #{detail}" : ''}"
  $failures << name unless cond
end

def wait_until(timeout: 20, interval: 0.2)
  deadline = Time.now + timeout
  loop do
    v = yield
    return v if v
    raise "timed out after #{timeout}s" if Time.now > deadline
    sleep interval
  end
end

system(File.join(ROOT, 'scripts', 'build.sh'), 'chrome', out: File::NULL) or abort 'build failed'
tmp = File.join(ENV['TMPDIR'] || '/tmp', "graphi-chrome-#{Process.pid}")
ext_dir = File.join(tmp, 'extension')
ext_id = ChromeDriver.prepare_extension(File.join(ROOT, 'dist', 'chrome'), ext_dir)
server = Process.spawn('ruby', File.join(ROOT, 'tests', 'support', 'server.rb'), PORT.to_s, out: File::NULL, err: File::NULL)
at_exit { Process.kill('TERM', server) rescue nil }
sleep 0.6

d = ChromeDriver.new(extension_dir: ext_dir, profile: File.join(tmp, 'profile'),
                     extra_args: ["--host-resolver-rules=MAP docs.google.com 127.0.0.1:#{PORT}"])
at_exit { d.quit; FileUtils.rm_rf(tmp) }

EXT = "chrome-extension://#{ext_id}"
POPUP = "#{EXT}/popup/popup.html"
ctl = d.handle
page = d.new_window

ext = lambda do |body, args = []|
  d.switch_to(ctl)
  v = d.js(body, args)
  d.switch_to(page)
  v
end
FAST = {
  wpm: 250, variability: 0, typoRate: 0, punctuationPauses: false, thinkingBreaks: 'off', countdown: 0,
  speedDrift: false, pauseWhenHidden: false, pauseOnInteraction: true, escToStop: true, showHud: true,
  correction: 'natural', docsMethod: 'auto', paceMode: 'wpm', autoReport: false
}.freeze
configure = lambda do |text, **s|
  ext.call(<<~JS, [FAST.merge(s), text])
    const now = Date.now();
    await chrome.storage.local.set({ settings: args[0],
      library: { docs: [{ id: 'c1', title: 'Chrome test', text: args[1], createdAt: now, updatedAt: now }], activeId: 'c1' } });
    await chrome.storage.local.remove(['lastSession']);
    return true;
  JS
end
tab_id = -> { ext.call("const t = await chrome.tabs.query({}); return t.find(x => x.url && x.url.startsWith(args[0]))?.id ?? null;", [BASE]) }
popup_msg = ->(msg) { ext.call('return await chrome.runtime.sendMessage({ ...args[0], tabId: args[1] });', [msg, tab_id.call]) }
open = lambda do |path|
  d.switch_to(page)
  d.navigate(path.start_with?('http') ? path : "#{BASE}/#{path}")
  sleep 0.3
end
value = ->(sel) { d.js('const el = document.querySelector(args[0]); return el.value ?? el.innerText;', [sel]) }
focus = ->(sel) { d.js('const el = document.querySelector(args[0]); if (el.value !== undefined) el.value = ""; else el.textContent = ""; el.focus(); return true;', [sel]) }
type_into = lambda do |sel, text, timeout: 30|
  focus.call(sel)
  res = popup_msg.call({ type: 'popup:start' })
  ok = (wait_until(timeout: timeout) { value.call(sel) == text } rescue false)
  [res, ok]
end

LINE = 'Hello, world! Graphi types like a human: 123 & (symbols) — “quotes” é 😀 done.'
MULTI = "First line.\nSecond line, with comma.\n\nNew paragraph ✓"

puts "\n\e[1mLoading in Chrome\e[0m"
d.switch_to(ctl)
d.navigate("#{POPUP}?tab=-1")
ready = (wait_until { d.js('return document.documentElement.dataset.ready') == 'true' } rescue false)
check 'popup page loads in Chrome', ready
info = d.js(<<~JS)
  document.querySelector('.tab[data-view="settings"]').click();
  await new Promise(r => setTimeout(r, 300));
  return { rows: document.querySelectorAll('#shortcuts .shortcut-row').length,
           note: document.getElementById('shortcutNote').textContent,
           privateBtn: document.getElementById('copyAddons').textContent,
           version: document.getElementById('version').textContent,
           worker: !!(await chrome.runtime.sendMessage({ type: 'popup:shortcuts' })).toggle };
JS
check 'service worker answers the popup', info['worker'], info.inspect
check 'shortcuts list shows all three commands', info['rows'] == 3
check "Settings sends Chrome users to the browser's shortcut page", info['note'].include?("browser's shortcuts page")
check 'private-window help points to Chrome’s extension details', info['privateBtn'] == 'Open extension details'

puts "\n\e[1mTyping\e[0m"
configure.call(LINE)
open.call('playground.html')
res, ok = type_into.call('#plain', LINE)
check 'popup start is accepted', res && res['ok'], res.inspect
check 'plain input: exact text, emoji and quotes intact', ok, value.call('#plain').inspect

configure.call(MULTI, typoRate: 8)
open.call('playground.html')
_, ok = type_into.call('#area', MULTI)
check 'textarea: multi-line text with typos ends up exact', ok, value.call('#area').inspect

configure.call(MULTI)
open.call('playground.html')
type_into.call('#rich', MULTI, timeout: 10)
# innerText reports an empty paragraph as an extra line break; compare blocks.
rich = d.js("const el = document.getElementById('rich'); return { text: el.textContent, lines: el.innerText.replace(/\\n+/g, '\\n') };")
check 'contenteditable: paragraphs typed exactly', rich['text'] == MULTI.delete("\n") && rich['lines'] == MULTI.gsub(/\n+/, "\n"), rich.inspect

configure.call('React state stays in sync.')
open.call('playground.html')
d.js("document.getElementById('reactInput').focus(); return true;")
popup_msg.call({ type: 'popup:start' })
ok = (wait_until { d.js("return window.__react.a") == 'React state stays in sync.' } rescue false)
check 'React controlled input: component state matches', ok, d.js("return window.__react.a").inspect

puts "\n\e[1mPause, resume, stop\e[0m"
long = 'Pausing and resuming keeps every character in order. ' * 4
configure.call(long, wpm: 120)
open.call('playground.html')
focus.call('#area')
popup_msg.call({ type: 'popup:start' })
wait_until { value.call('#area').length > 15 }
pz = popup_msg.call({ type: 'popup:control', action: 'pause' })
check 'pause from the popup', pz['ok'] && pz['snapshot']['state'] == 'paused', pz.inspect
v1 = value.call('#area'); sleep 0.8
check 'nothing is typed while paused', value.call('#area') == v1
popup_msg.call({ type: 'popup:control', action: 'resume' })
wait_until { value.call('#area').length > v1.length + 10 }
st = popup_msg.call({ type: 'popup:control', action: 'stop' })
check 'stop from the popup', st['ok'], st.inspect
sleep 0.4
last = ext.call("return (await chrome.storage.local.get('lastSession')).lastSession")
check 'resume point is saved on stop', last && last['state'] == 'stopped' && last['offset'] == value.call('#area').length, last.inspect
check 'stopped text is a clean prefix of the original', long.start_with?(value.call('#area'))
res = popup_msg.call({ type: 'popup:start', docId: 'c1', offset: last['offset'] })
ok = (wait_until(timeout: 30) { value.call('#area') == long } rescue false)
check 'resuming from the saved point completes the text exactly', res['ok'] && ok

puts "\n\e[1mOn-page panel and badge\e[0m"
configure.call(long, wpm: 60)
open.call('playground.html')
focus.call('#area')
popup_msg.call({ type: 'popup:start' })
sleep 1
check 'the on-page panel appears', d.js("return !!document.querySelector('graphi-hud')")
badge = ext.call('return await chrome.action.getBadgeText({ tabId: args[0] });', [tab_id.call])
check "toolbar badge shows progress (#{badge})", badge.to_s.end_with?('%')
popup_msg.call({ type: 'popup:control', action: 'stop' })

puts "\n\e[1mGoogle Docs simulator\e[0m"
TEXT = 'Docs in Chrome: typed key by key. ✓'
%w[textinput keypress input].each do |accept|
  configure.call(TEXT)
  d.switch_to(page)
  d.navigate("http://docs.google.com:#{PORT}/document/d/test/edit?accept=#{accept}")
  sleep 0.6
  tid = ext.call("return (await chrome.tabs.query({})).find(t => (t.url || '').includes('docs.google.com'))?.id;")
  ext.call('return await chrome.runtime.sendMessage({ type: "popup:start", tabId: args[0] });', [tid])
  got = (wait_until(timeout: 30) { (v = d.js('return window.__docText()')) == TEXT ? v : nil } rescue d.js('return window.__docText()'))
  check "Docs (#{accept} events): document text is exact", got == TEXT, got.inspect
end

puts "\n\e[1mReports\e[0m"
configure.call(MULTI, typoRate: 6)
open.call('playground.html')
_, ok = type_into.call('#area', MULTI)
rep = (wait_until(timeout: 5) { ext.call("return ((await chrome.storage.local.get('reports')).reports || [])[0] || null") } rescue nil)
check 'a report is saved', ok && rep && rep['outcome'] == 'done'
d.switch_to(ctl)
d.navigate("#{EXT}/report/report.html?id=#{rep && rep['id']}")
wait_until { d.js('return document.documentElement.dataset.ready') == 'true' }
sleep 0.4
r = d.js("return { ink: document.getElementById('ink').textContent, bars: document.querySelectorAll('#rhythmChart .bar').length, paras: document.querySelectorAll('#paraTable tbody tr').length };")
check 'report page renders in Chrome with replay and charts', r['ink'] == MULTI && r['bars'] == 9 && r['paras'] == 3, r.inspect
d.screenshot(File.join(ROOT, 'docs', 'screenshots', 'chrome-report.png'))
d.navigate("#{POPUP}?tab=-1")
wait_until { d.js('return document.documentElement.dataset.ready') == 'true' }

puts "\n\e[1mScheduled breaks\e[0m"
configure.call('Short break test, with a few words to type here. ' * 3, wpm: 250, breakEvery: 15, breakLength: 1, _breakEveryMs: 2500, _breakLengthMs: 2000)
open.call('playground.html')
focus.call('#area')
popup_msg.call({ type: 'popup:start' })
snap = (wait_until(timeout: 15, interval: 0.1) { s = popup_msg.call({ type: 'popup:status' })['snapshot']; s && s['breakLeft'].to_i > 0 ? s : nil } rescue nil)
check 'a break starts and the popup shows it', !!snap

puts "\n\e[1mProtected pages\e[0m"
open.call('playground.html')
protected_tab = tab_id.call
d.switch_to(page)
d.navigate('chrome://version')
sleep 0.4
st = ext.call("return await chrome.runtime.sendMessage({ type: 'popup:status', tabId: args[0] });", [protected_tab])
check 'built-in Chrome pages are explained, not silently failed', st['restricted'].to_s.include?("built-in pages"), st.inspect

puts($failures.empty? ? "\e[32mAll Chrome checks passed.\e[0m" : "\e[31mFailed: #{$failures.join(', ')}\e[0m")
exit($failures.empty? ? 0 : 1)
