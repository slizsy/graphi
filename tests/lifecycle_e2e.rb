# Lifecycle tests: real toolbar popup, persistence across a Firefox restart,
# and recovery after the extension is reloaded.
require_relative 'harness'
include Harness

PROFILE = File.join(ENV['TMPDIR'] || '/tmp', "graphi-life-#{Process.pid}")
start_server

def popup_tab(m)
  m.navigate("#{POPUP}?tab=-1")
  wait_until { m.js('return document.documentElement.dataset.ready') == 'true' }
  sleep 0.3
end

# ---- Session 1 ----------------------------------------------------------------
m = boot(PROFILE, port: 2950)
install(m)

puts "\n\e[1mToolbar button and popup panel\e[0m"
m.navigate("#{BASE}/playground.html")
info = chrome(m, <<~JS)
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  const node = win.document.getElementById("graphi_graphi_app-BAP") ||
               win.document.getElementById("graphi_graphi_app-browser-action");
  if (!node) return { found: false };
  const inNavbar = !!node.closest("#nav-bar");
  // Headless windows are never "active", so Firefox may auto-close the panel
  // shortly after it opens. Sample the popup the moment its document is ready,
  // and retry the click a few times if it closed before we saw it.
  for (let attempt = 0; attempt < 4; attempt++) {
    win.focus();
    node.click();
    for (let i = 0; i < 120; i++) {
      const b = [...win.document.querySelectorAll("browser")]
        .find(x => x.currentURI?.spec?.endsWith("popup/popup.html") && x.contentTitle === "Graphi");
      if (b) {
        const w = parseInt(b.style.width) || b.clientWidth;
        const h = parseInt(b.style.height) || b.clientHeight;
        if (w >= 100 && h >= 100) return { found: true, inNavbar, opened: true, title: b.contentTitle, w, h, attempt };
      }
      await new Promise(r => win.setTimeout(r, 25));
    }
  }
  return { found: true, inNavbar, opened: false };
JS
check 'toolbar button is pinned to the navigation bar', info['inNavbar'], info.inspect
check 'clicking it opens the Graphi popup', info['opened'] && info['title'] == 'Graphi', info.inspect
check "popup panel is sized to the design (#{info['w']}×#{info['h']})", info['w'].to_i >= 380 && info['h'].to_i >= 560
chrome(m, 'const win = Services.wm.getMostRecentWindow("navigator:browser"); win.document.querySelector("panel[viewId], #customizationui-widget-panel, .panel-viewstack")?.closest("panel")?.hidePopup?.(); return true;')

puts "\n\e[1mEditing through the real UI\e[0m"
popup_tab(m)
m.click('.tab[data-view="tune"]')
3.times { m.click('.step-btn[data-step="5"]') }
m.click('.segmented[data-setting="thinkingBreaks"] button[data-value="frequent"]')
m.click('label.switch:has(#speedDrift)')
m.click('.tab[data-view="settings"]')
m.click('label.switch:has(#showHud)')
m.click('.tab[data-view="library"]')
m.click('#newDoc')
sleep 0.3
m.click('#docTitle')
m.key_actions('Restart proof'.chars)
m.click('#editor')
m.key_actions('Survives a restart.'.chars)
sleep 1 # debounce
stored = m.js("return await browser.storage.local.get(['settings', 'library'])")
s = stored['settings']
doc = stored['library']['docs'].find { |d| d['id'] == stored['library']['activeId'] }
check 'speed steppers saved (75 → 90 wpm)', s['wpm'] == 90, s['wpm'].inspect
check 'segmented + toggles saved', s['thinkingBreaks'] == 'frequent' && s['speedDrift'] == false && s['showHud'] == false
check 'new text saved with typed title and body', doc && doc['title'] == 'Restart proof' && doc['text'] == 'Survives a restart.', doc.inspect

# Shortcut recorder → commands.update
m.click('.tab[data-view="settings"]')
m.click('.keys[data-command="stop-typing"]')
m.cmd('WebDriver:PerformActions', { 'actions' => [{ 'type' => 'key', 'id' => 'k', 'actions' => [
  { 'type' => 'keyDown', 'value' => "" }, { 'type' => 'keyDown', 'value' => "" },
  { 'type' => 'keyDown', 'value' => 'j' }, { 'type' => 'keyUp', 'value' => 'j' },
  { 'type' => 'keyUp', 'value' => "" }, { 'type' => 'keyUp', 'value' => "" }] }] })
m.cmd('WebDriver:ReleaseActions')
sleep 0.5
cmds = m.js("return (await browser.commands.getAll()).find(c => c.name === 'stop-typing').shortcut")
check "shortcut recorder rebinds a command (now #{cmds})", cmds == 'Alt+Shift+J'

m.quit
puts "\n\e[1mAfter restarting Firefox\e[0m"

# ---- Session 2: same profile ------------------------------------------------------
m = boot(PROFILE, port: 2950, fresh: false)
install(m)
popup_tab(m)
stored = m.js("return await browser.storage.local.get(['settings', 'library'])")
s = stored['settings'] || {}
check 'settings survived the restart', s['wpm'] == 90 && s['thinkingBreaks'] == 'frequent' && s['showHud'] == false, s.inspect
docs = stored.dig('library', 'docs') || []
check 'texts survived the restart', docs.any? { |d| d['title'] == 'Restart proof' && d['text'] == 'Survives a restart.' }, docs.map { |d| d['title'] }.inspect
check 'popup reopens on the saved text', m.js("return document.getElementById('editor').value") == 'Survives a restart.'
check 'tune view reflects saved speed', m.js("return document.getElementById('wpmValue').textContent") == '90'

puts "\n\e[1mExtension reload with a page that already ran Graphi\e[0m"
m.js(<<~JS)
  const { settings } = await browser.storage.local.get('settings');
  await browser.storage.local.set({ settings: { ...settings, wpm: 250, countdown: 0, typoRate: 0, variability: 0,
    thinkingBreaks: 'off', punctuationPauses: false, pauseWhenHidden: false, showHud: true } });
  return true;
JS
page = m.cmd('WebDriver:NewWindow', { 'type' => 'window', 'focus' => true })['handle']
m.cmd('WebDriver:SwitchToWindow', { 'handle' => page, 'focus' => true })
m.navigate("#{BASE}/playground.html")
m.js("document.getElementById('plain').focus(); return true;")
fire_command(m, 'toggle-typing')
ok1 = (wait_until(timeout: 15) { m.js("return document.getElementById('plain').value") == 'Survives a restart.' } rescue false)
check 'types before reload', ok1
chrome(m, 'const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs"); const a = await AddonManager.getAddonByID("graphi@graphi.app"); await a.reload(); return true;')
sleep 1.5
m.js("const p = document.getElementById('plain'); p.value = ''; p.focus(); return true;")
fire_command(m, 'toggle-typing')
ok2 = (wait_until(timeout: 15) { m.js("return document.getElementById('plain').value") == 'Survives a restart.' } rescue false)
check 'types again after the extension reloads (no stale runtime)', ok2, m.js("return document.getElementById('plain').value").inspect

puts "Console: #{console_errors(m).reject { |x| x.include?('Ignored listener') }.uniq.first(5).inspect}"
m.quit
FileUtils.rm_rf(PROFILE)
puts($failures.empty? ? "\e[32mAll lifecycle checks passed.\e[0m" : "\e[31mFailed: #{$failures.join(', ')}\e[0m")
exit($failures.empty? ? 0 : 1)
