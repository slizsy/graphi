# End-to-end tests for Graphi in a real (headless) Firefox.
#
#   ruby tests/e2e.rb            # full suite
#   ruby tests/e2e.rb fields     # only groups whose name matches
#
# Two windows are used: a "control" window running a Graphi extension page
# (to seed storage and talk to the background script) and a "page" window with
# the site under test — so the page never becomes a hidden background tab.
require_relative 'harness'
include Harness

FILTER = ARGV[0]
PROFILE = File.join(ENV['TMPDIR'] || '/tmp', "graphi-e2e-#{Process.pid}")

FAST = {
  wpm: 250, variability: 0, typoRate: 0, punctuationPauses: false, thinkingBreaks: 'off', countdown: 0,
  speedDrift: false, pauseWhenHidden: false, pauseOnInteraction: true, escToStop: true, showHud: true,
  correction: 'natural', docsMethod: 'auto'
}.freeze

LINE = 'Hello, world! Graphi types like a human: 123 & (symbols) — “quotes” é 😀 done.'
MULTI = "First line.\nSecond line, with comma.\n\nNew paragraph ✓"

class Suite
  attr_reader :m

  def initialize(m)
    @m = m
    @ctl = m.cmd('WebDriver:GetWindowHandle')['value']
    m.navigate("#{POPUP}?tab=-1")
    win = m.cmd('WebDriver:NewWindow', { 'type' => 'window', 'focus' => true })
    @page = win['handle']
    page!
  end

  def page!
    m.cmd('WebDriver:SwitchToWindow', { 'handle' => @page, 'focus' => true })
  end

  def ctl!
    m.cmd('WebDriver:SwitchToWindow', { 'handle' => @ctl, 'focus' => true })
  end

  # Runs JS in the extension's control page, then returns to the page window.
  def ext_js(body, args = [])
    ctl!
    v = m.js(body, args)
    page!
    v
  end

  def configure(text: LINE, **settings)
    s = FAST.merge(settings)
    ext_js(<<~JS, [s, text])
      const [settings, text] = args;
      const now = Date.now();
      await browser.storage.local.set({
        settings,
        library: { docs: [{ id: 'doc-1', title: 'Test text', text, createdAt: now, updatedAt: now }], activeId: 'doc-1' },
      });
      await browser.storage.local.remove('lastSession');
      return true;
    JS
  end

  def set_settings(patch)
    ext_js("const { settings } = await browser.storage.local.get('settings'); await browser.storage.local.set({ settings: { ...settings, ...args[0] } }); return true;", [patch])
  end

  def last_session
    ext_js("return (await browser.storage.local.get('lastSession')).lastSession || null;")
  end

  def tab_id
    page!
    selected_tab_id(m)
  end

  def popup_msg(msg)
    tid = tab_id
    ext_js('return await browser.runtime.sendMessage({ ...args[0], tabId: args[1] });', [msg, tid])
  end

  def status
    popup_msg({ type: 'popup:status' })['snapshot']
  end

  def open(path)
    page!
    m.navigate(path.start_with?('http') ? path : "#{BASE}/#{path}")
    sleep 0.4
  end

  def focus(sel)
    m.js("const el = document.querySelector(args[0]); el.focus(); return true;", [sel])
  end

  def value(sel)
    m.js("const el = document.querySelector(args[0]); return el.value ?? el.innerText;", [sel])
  end

  def badge
    chrome(m, <<~JS)
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      const btn = win.document.getElementById("graphi_graphi_app-BAP") || win.document.getElementById("graphi_graphi_app-browser-action");
      return btn ? (btn.getAttribute("badge") || "") : null;
    JS
  end

  def toggle!
    page!
    fire_command(m, 'toggle-typing')
  end

  def stop!
    page!
    fire_command(m, 'stop-typing')
  end

  def hud?
    m.js("return !!document.querySelector('graphi-hud');")
  end

  def wait_value(sel, expected, timeout: 30)
    wait_until(timeout: timeout) { value(sel) == expected }
    true
  rescue RuntimeError
    false
  end

  def wait_badge(timeout: 10, &blk)
    wait_until(timeout: timeout) { b = badge; blk.call(b) ? (b || '') : nil }
  rescue RuntimeError
    nil
  end

  def press(*keys)
    page!
    m.key_actions(keys)
  end

  def click(sel)
    page!
    m.click(sel)
  end
end

def group(name)
  return if FILTER && !name.include?(FILTER)
  puts "\n\e[1m#{name}\e[0m"
  yield
rescue StandardError => e
  puts "  \e[31m✗ #{name} crashed: #{e.message.lines.first}\e[0m"
  $failures << "#{name} (crash)"
end

start_server
m = boot(PROFILE)
install(m)
t = Suite.new(m)

group 'fields: keyboard shortcut starts typing (activeTab only)' do
  t.configure(text: LINE)
  t.open('playground.html')
  t.focus('#plain')
  t.toggle!
  check 'badge shows live progress', t.wait_badge { |b| b =~ /\d+%/ }
  check 'on-page HUD is shown', t.hud?
  check 'plain input receives exact text (emoji, quotes, accents)', t.wait_value('#plain', LINE)
  evs = m.js("return __events.filter(e => e.id === 'plain')")
  check 'every edit fired a trusted input event', evs.any? && evs.all? { |e| e['trusted'] }, evs.reject { |e| e['trusted'] }.first.inspect
  check 'badge clears when finished', t.wait_badge(timeout: 6) { |b| b == '' || b == '✓' }
end

group 'fields: textarea, contenteditable, React, masks, iframes' do
  t.configure(text: MULTI)
  t.open('playground.html')
  t.focus('#area'); t.toggle!
  check 'textarea keeps line breaks', t.wait_value('#area', MULTI)

  t.open('playground.html')
  t.focus('#rich'); t.toggle!
  ok = t.wait_value('#rich', MULTI) || t.value('#rich').gsub(/\n+/, "\n") == MULTI.gsub(/\n+/, "\n")
  check 'contenteditable receives paragraphs', ok, t.value('#rich').inspect

  t.configure(text: LINE)
  t.open('playground.html')
  t.focus('#reactInput'); t.toggle!
  t.wait_value('#reactInput', LINE)
  check 'React controlled input state matches', m.js('return window.__react.a') == LINE, m.js('return window.__react.a').inspect

  t.configure(text: MULTI)
  t.open('playground.html')
  t.focus('#reactArea'); t.toggle!
  t.wait_value('#reactArea', MULTI)
  check 'React controlled textarea state matches', m.js('return window.__react.b') == MULTI

  t.configure(text: 'abc def')
  t.open('playground.html')
  t.focus('#mask'); t.toggle!
  sleep 2.5
  check 'input mask that inserts on keydown is not doubled', t.value('#mask') == 'abc def', t.value('#mask').inspect

  t.configure(text: 'inside a frame')
  t.open('playground.html')
  m.js("const f = document.getElementById('frame'); f.contentDocument.getElementById('inner').focus(); return true;")
  t.toggle!
  ok = wait_until(timeout: 15) { m.js("return document.getElementById('frame').contentDocument.getElementById('inner').value") == 'inside a frame' } rescue false
  check 'same-origin iframe textarea is reached', ok
end

group 'errors: limits and unsupported fields' do
  t.configure(text: 'abcdefghij')
  t.open('playground.html')
  t.focus('#short'); t.toggle!
  check 'maxlength stops with an error badge', t.wait_badge { |b| b == '!' }
  check 'text up to the limit was typed', t.value('#short') == 'abcde'

  t.open('playground.html')
  t.focus('#num')
  grant_active_tab(m)
  res = t.popup_msg({ type: 'popup:start' })
  check 'number input is refused with a clear message', res['ok'] == false && res['error'].to_s.include?('number'), res.inspect

  t.open('playground.html')
  t.focus('#ro')
  grant_active_tab(m)
  res = t.popup_msg({ type: 'popup:start' })
  check 'read-only field is refused', res['ok'] == false && res['error'].to_s =~ /read-only/i, res.inspect

  t.configure(text: '   ')
  t.open('playground.html')
  t.focus('#plain')
  grant_active_tab(m)
  res = t.popup_msg({ type: 'popup:start' })
  check 'empty text is refused', res['ok'] == false && res['error'].to_s =~ /nothing to type/i, res.inspect

  m.navigate('about:robots')
  grant_active_tab(m)
  st = t.popup_msg({ type: 'popup:status' })
  check 'built-in pages are reported as unavailable', st['restricted'].to_s =~ /built-in/i, st.inspect
end

group 'arming: waits for a click into a field' do
  t.configure(text: 'typed after click')
  t.open('playground.html')
  m.js('document.activeElement?.blur(); return true;')
  t.toggle!
  check 'badge shows waiting state', t.wait_badge { |b| b == '…' }
  t.click('#area')
  check 'typing starts in the clicked field', t.wait_value('#area', 'typed after click')
end

LONG = 'The quick brown fox jumps over the lazy dog. ' * 4

group 'controls: pause, resume, stop, resume-from-offset' do
  t.configure(text: LONG.strip, wpm: 150)
  t.open('playground.html')
  t.focus('#area'); t.toggle!
  sleep 1.6
  t.toggle!
  check 'shortcut pauses (badge II)', t.wait_badge { |b| b == 'II' }
  len1 = t.value('#area').length
  sleep 1.2
  check 'nothing is typed while paused', t.value('#area').length == len1
  check 'status reports paused', t.status&.dig('state') == 'paused'
  t.toggle!
  check 'shortcut resumes', t.wait_badge { |b| b =~ /%/ }
  check 'text completes exactly after resume', t.wait_value('#area', LONG.strip, timeout: 40)

  t.open('playground.html')
  t.focus('#area'); t.toggle!
  sleep 2
  t.stop!
  sleep 0.5
  typed = t.value('#area')
  check 'stop shortcut ends the session', t.status.nil? && typed.length > 5 && typed.length < LONG.strip.length
  sleep 0.6
  ls = t.last_session
  check 'stop point is remembered', ls && ls['state'] == 'stopped' && ls['offset'] == typed.length, ls.inspect
  grant_active_tab(m)
  t.focus('#area')
  m.js("const a = document.getElementById('area'); a.setSelectionRange(a.value.length, a.value.length); return true;")
  res = t.popup_msg({ type: 'popup:start', docId: 'doc-1', offset: ls['offset'] })
  check 'resume-from-offset starts', res['ok'], res.inspect
  check 'resumed text joins up exactly', t.wait_value('#area', LONG.strip, timeout: 40), t.value('#area').inspect
end

group 'takeover: user clicks, keys and Esc' do
  t.configure(text: LONG.strip, wpm: 150)
  t.open('playground.html')
  t.focus('#area'); t.toggle!
  sleep 1.2
  t.click('h1')
  check 'a click in the page pauses typing', t.wait_badge { |b| b == 'II' }
  check 'pause reason is explained', t.status&.dig('pauseReason').to_s =~ /clicked/i
  res = t.popup_msg({ type: 'popup:control', action: 'resume' })
  check 'resume from popup control works', res['ok']
  check 'caret is restored and text completes exactly', t.wait_value('#area', LONG.strip, timeout: 40), t.value('#area')[-40..].inspect

  t.open('playground.html')
  t.focus('#area'); t.toggle!
  sleep 1.2
  t.press('z')
  check 'a real key press pauses typing', t.wait_badge { |b| b == 'II' }
  t.popup_msg({ type: 'popup:control', action: 'resume' })
  check 'the user key was swallowed (text exact)', t.wait_value('#area', LONG.strip, timeout: 40)

  t.open('playground.html')
  t.focus('#area'); t.toggle!
  sleep 1.2
  t.press("") # Escape
  sleep 0.4
  check 'Esc stops typing', t.status.nil? && t.wait_badge { |b| b == '' }
  len = t.value('#area').length
  sleep 0.8
  check 'nothing typed after Esc', t.value('#area').length == len
end

group 'humanisation: typos are corrected, speed is honoured' do
  t.configure(text: LONG.strip, typoRate: 8, correction: 'natural', variability: 40, speedDrift: true)
  t.open('playground.html')
  t.focus('#area'); t.toggle!
  check 'final text is exact despite typos', t.wait_value('#area', LONG.strip, timeout: 60)
  bs = m.js("return __events.filter(e => e.id === 'area' && e.type === 'deleteContentBackward').length")
  check "mistakes were made and corrected (#{bs} backspaces)", bs > 0

  timing = lambda do |wpm|
    text = 'the quick brown fox jumps over the lazy dog'
    t.configure(text: text, wpm: wpm)
    t.open('playground.html')
    m.js("window.__times = []; document.getElementById('area').addEventListener('input', () => __times.push(performance.now())); return true;")
    t.focus('#area'); t.toggle!
    t.wait_value('#area', text, timeout: 30)
    times = m.js('return __times')
    (times.last - times.first) / (times.length - 1)
  end
  slow = timing.call(100)
  fast = timing.call(200)
  check "100 wpm ≈ 120 ms/key (measured #{slow.round} ms)", (slow - 120).abs < 120 * 0.2
  check "200 wpm ≈ 60 ms/key (measured #{fast.round} ms)", (fast - 60).abs < 60 * 0.25
end

group 'live tuning and background tabs' do
  t.configure(text: LONG.strip * 2, wpm: 40)
  t.open('playground.html')
  t.focus('#area'); t.toggle!
  sleep 2
  a0 = t.value('#area').length; sleep 2; a1 = t.value('#area').length
  t.set_settings(wpm: 240)
  sleep 0.5
  b0 = t.value('#area').length; sleep 2; b1 = t.value('#area').length
  check "speed change applies mid-session (#{a1 - a0} → #{b1 - b0} chars / 2s)", (b1 - b0) > (a1 - a0) * 3
  t.stop!

  t.configure(text: LONG.strip, wpm: 120, pauseWhenHidden: true)
  t.open('playground.html')
  t.focus('#area'); t.toggle!
  sleep 1
  page_handle = m.cmd('WebDriver:GetWindowHandle')['value']
  other = m.cmd('WebDriver:NewWindow', { 'type' => 'tab', 'focus' => true })['handle']
  m.cmd('WebDriver:SwitchToWindow', { 'handle' => other, 'focus' => true })
  sleep 0.8
  m.cmd('WebDriver:SwitchToWindow', { 'handle' => page_handle, 'focus' => true })
  hidden_len = t.value('#area').length
  m.cmd('WebDriver:SwitchToWindow', { 'handle' => other, 'focus' => true })
  sleep 1
  m.cmd('WebDriver:SwitchToWindow', { 'handle' => page_handle, 'focus' => true })
  check 'typing pauses while the tab is hidden', t.value('#area').length <= hidden_len + 1
  m.cmd('WebDriver:SwitchToWindow', { 'handle' => other, 'focus' => true })
  m.cmd('WebDriver:CloseWindow')
  m.cmd('WebDriver:SwitchToWindow', { 'handle' => page_handle, 'focus' => true })
  check 'typing resumes when the tab is visible again', t.wait_value('#area', LONG.strip, timeout: 40)

  t.configure(text: 'no panel', showHud: false)
  t.open('playground.html')
  t.focus('#plain'); t.toggle!
  t.wait_value('#plain', 'no panel')
  check 'HUD can be turned off', !t.hud?
end

group 'embedded: cross-origin frames need the optional permission' do
  t.configure(text: 'typed across origins')
  t.open('cross.html')
  sleep 0.6
  focus_inner = lambda do
    t.page!
    frame = m.cmd('WebDriver:FindElement', { 'using' => 'css selector', 'value' => '#x' })['value']
    m.cmd('WebDriver:SwitchToFrame', { 'id' => frame.values.first, 'element' => frame.values.first })
    m.js("document.getElementById('inner').focus(); return true;")
    m.cmd('WebDriver:SwitchToParentFrame')
  end
  read_inner = lambda do
    frame = m.cmd('WebDriver:FindElement', { 'using' => 'css selector', 'value' => '#x' })['value']
    m.cmd('WebDriver:SwitchToFrame', { 'id' => frame.values.first, 'element' => frame.values.first })
    v = m.js("return document.getElementById('inner').value")
    m.cmd('WebDriver:SwitchToParentFrame')
    v
  end
  focus_inner.call
  grant_active_tab(m)
  res = t.popup_msg({ type: 'popup:start' })
  check 'without permission: explains how to enable embedded editors', res['ok'] == false && res['error'].to_s.include?('Embedded editors'), res.inspect

  chrome(m, "#{EXT} const { ExtensionPermissions } = ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs'); await ExtensionPermissions.add(ext.id, { permissions: [], origins: ['<all_urls>'] }, ext); return true;")
  t.open('cross.html')
  sleep 0.6
  focus_inner.call
  t.toggle!
  ok = (wait_until(timeout: 15) { read_inner.call == 'typed across origins' } rescue false)
  check 'with permission: types inside the cross-origin frame', ok, read_inner.call.inspect
  chrome(m, "#{EXT} const { ExtensionPermissions } = ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs'); await ExtensionPermissions.remove(ext.id, { permissions: [], origins: ['<all_urls>'] }, ext); return true;")
end

group 'popup: start button drives the page' do
  t.configure(text: 'from the popup button', countdown: 0)
  t.open('playground.html')
  t.focus('#plain')
  tid = t.tab_id
  grant_active_tab(m)
  t.ctl!
  m.navigate("#{POPUP}?tab=#{tid}")
  wait_until { m.js('return document.documentElement.dataset.ready') == 'true' }
  check 'popup shows the active text', m.js("return document.getElementById('editor').value") == 'from the popup button'
  m.click('#startBtn')
  t.page!
  check 'start button types into the page', t.wait_value('#plain', 'from the popup button')
end

puts
if $failures.empty?
  puts "\e[32mAll checks passed.\e[0m"
else
  puts "\e[31m#{$failures.size} failed:\e[0m #{$failures.join(', ')}"
end
puts "Console: #{console_errors(m).uniq.first(6).inspect}"
m.quit
FileUtils.rm_rf(PROFILE)
exit($failures.empty? ? 0 : 1)
