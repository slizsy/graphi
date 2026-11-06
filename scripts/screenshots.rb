# Captures every popup view and state for design review → docs/screenshots/
require_relative '../tests/support/harness'
include Harness

OUT = SCREENSHOTS
FileUtils.mkdir_p(OUT)
PROFILE = File.join(ENV['TMPDIR'] || '/tmp', "graphi-shots-#{Process.pid}")

ESSAY = <<~TXT.strip
  The printing press did not just make books cheaper; it changed how people thought about knowledge itself. Before Gutenberg, a text was a living thing, copied and corrected by hand, slightly different in every edition.

  Once type was set, the words stood still. Readers across Europe could point to the same line on the same page — and argue about it.
TXT

def shoot(m, name, sel = '#app')
  el = m.cmd('WebDriver:FindElement', { 'using' => 'css selector', 'value' => sel })['value'].values.first
  data = m.cmd('WebDriver:TakeScreenshot', { 'id' => el, 'hash' => false })['value']
  File.binwrite(File.join(OUT, "#{name}.png"), Base64.decode64(data))
  puts "  saved #{name}.png"
end

start_server
m = boot(PROFILE, port: 2948)
install(m)
m.cmd('WebDriver:SetWindowRect', { 'width' => 520, 'height' => 760 })
popup_ready = -> { wait_until { m.js('return document.documentElement.dataset.ready') == 'true' }; sleep 0.5 }

m.navigate("#{POPUP}?tab=-1")
popup_ready.call
m.js(<<~JS, [ESSAY])
  const now = Date.now();
  await browser.storage.local.set({ library: { docs: [
    { id: 'a', title: 'Essay — The printing press', text: args[0], createdAt: now - 4e5, updatedAt: now - 3e5 },
    { id: 'b', title: 'Cover letter draft', text: 'Dear hiring team,\\n\\nI am writing to apply for the product designer role. Over the last five years I have…', createdAt: now - 9e7, updatedAt: now - 8.6e7 },
    { id: 'c', title: 'Lab report intro', text: 'In this experiment we measured the rate of reaction between sodium thiosulfate and hydrochloric acid at five temperatures.', createdAt: now - 3e8, updatedAt: now - 2.6e8 },
  ], activeId: 'a' } });
  await browser.storage.local.set({ lastSession: { docId: 'a', title: 'Essay — The printing press', offset: 162, total: Array.from(args[0]).length, fingerprint: '', state: 'stopped', url: '', at: now - 120000 } });
  return true;
JS
# the resume banner needs the real fingerprint
m.js(<<~JS)
  const { library } = await browser.storage.local.get('library');
  const t = library.docs[0].text; let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  const { lastSession } = await browser.storage.local.get('lastSession');
  await browser.storage.local.set({ lastSession: { ...lastSession, fingerprint: `${t.length}:${(h >>> 0).toString(36)}` } });
  return true;
JS

# A page to point the popup at, so the Start button is enabled.
page = m.cmd('WebDriver:NewWindow', { 'type' => 'window', 'focus' => true })['handle']
m.cmd('WebDriver:SwitchToWindow', { 'handle' => page, 'focus' => true })
m.navigate("#{BASE}/playground.html")
tid = selected_tab_id(m)
grant_active_tab(m)
popup = m.cmd('WebDriver:NewWindow', { 'type' => 'window', 'focus' => true })['handle']
m.cmd('WebDriver:SwitchToWindow', { 'handle' => popup, 'focus' => true })
m.cmd('WebDriver:SetWindowRect', { 'width' => 520, 'height' => 760 })

%w[compose tune library settings].each do |view|
  m.navigate("#{POPUP}?tab=#{tid}")
  popup_ready.call
  m.js("document.querySelector(`.tab[data-view='${args[0]}']`).click(); return true;", [view])
  sleep 0.6
  shoot(m, "popup-#{view}")
end

# Empty state
m.navigate("#{POPUP}?tab=#{tid}")
popup_ready.call
m.js("document.querySelector('.tab[data-view=compose]').click(); document.getElementById('newDoc').click(); return true;")
sleep 0.6
m.js("document.activeElement.blur(); return true;")
sleep 0.3
shoot(m, 'popup-empty')

# Live session in the dock
m.js(<<~JS)
  const { settings = {} } = await browser.storage.local.get('settings');
  await browser.storage.local.set({ settings: { ...settings, wpm: 45, countdown: 0, pauseWhenHidden: false },
    library: { ...(await browser.storage.local.get('library')).library, activeId: 'a' } });
  return true;
JS
m.cmd('WebDriver:SwitchToWindow', { 'handle' => page, 'focus' => true })
m.js("document.getElementById('area').focus(); return true;")
fire_command(m, 'toggle-typing')
sleep 4
m.screenshot(File.join(OUT, 'page-hud-typing.png'))
puts '  saved page-hud-typing.png'
m.cmd('WebDriver:SwitchToWindow', { 'handle' => popup, 'focus' => true })
m.navigate("#{POPUP}?tab=#{tid}")
popup_ready.call
sleep 1.2
shoot(m, 'popup-session-typing')
m.js("document.getElementById('pauseBtn').click(); return true;")
sleep 0.8
shoot(m, 'popup-session-paused')
m.cmd('WebDriver:SwitchToWindow', { 'handle' => page, 'focus' => true })
sleep 0.5
m.screenshot(File.join(OUT, 'page-hud-paused.png'))
puts '  saved page-hud-paused.png'

m.quit
FileUtils.rm_rf(PROFILE)
