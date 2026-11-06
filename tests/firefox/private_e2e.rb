# Private browsing: Graphi explains the permission while it is off, and once
# "Run in Private Windows" is allowed it types in private windows without
# leaving history behind (unless the user opts in).
require_relative '../support/harness'
include Harness

PROFILE = File.join(ENV['TMPDIR'] || '/tmp', "graphi-private-#{Process.pid}")
FAST = {
  wpm: 250, variability: 0, typoRate: 3, punctuationPauses: false, thinkingBreaks: 'off', countdown: 0,
  speedDrift: false, pauseWhenHidden: false, pauseOnInteraction: true, escToStop: true, showHud: true,
  correction: 'natural', docsMethod: 'auto', privateReports: false
}.freeze
TEXT = 'Typed in a private window.'

start_server
m = boot(PROFILE, port: 2954)
install(m)
ctl = m.cmd('WebDriver:GetWindowHandle')['value']
m.navigate("#{POPUP}?tab=-1")
wait_until { m.js('return document.documentElement.dataset.ready') == 'true' }

puts "\n\e[1mBefore the permission is granted\e[0m"
m.click('.tab[data-view="settings"]')
sleep 0.3
st = m.js("return { allowed: await browser.extension.isAllowedIncognitoAccess(), label: document.getElementById('privateState').textContent, help: getComputedStyle(document.getElementById('privateHelp')).display }")
check 'Settings shows private windows as not allowed, with steps', !st['allowed'] && st['label'] == 'Not allowed' && st['help'] != 'none', st.inspect

puts "\n\e[1mAfter allowing Run in Private Windows\e[0m"
m.navigate("#{BASE}/playground.html") # leave the extension page before it reloads
chrome(m, <<~JS)
  const { ExtensionPermissions } = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
  await ExtensionPermissions.add("graphi@graphi.app", { permissions: ["internal:privateBrowsingAllowed"], origins: [] });
  const a = await AddonManager.getAddonByID("graphi@graphi.app");
  await a.reload();
  return true;
JS
sleep 1.5
m.navigate("#{POPUP}?tab=-1")
wait_until { m.js('return document.documentElement.dataset.ready') == 'true' }
m.click('.tab[data-view="settings"]')
sleep 0.3
st = m.js("return { allowed: await browser.extension.isAllowedIncognitoAccess(), label: document.getElementById('privateState').textContent, help: getComputedStyle(document.getElementById('privateHelp')).display }")
check 'Settings shows private windows as allowed', st['allowed'] && st['label'] == 'Allowed' && st['help'] == 'none', st.inspect

ext = lambda do |body, args = []|
  switch_to(m, ctl)
  v = m.js(body, args)
  v
end
seed = lambda do |s|
  ext.call(<<~JS, [FAST.merge(s), TEXT])
    const now = Date.now();
    await browser.storage.local.set({ settings: args[0],
      library: { docs: [{ id: 'p1', title: 'Private', text: args[1], createdAt: now, updatedAt: now }], activeId: 'p1' } });
    await browser.storage.local.remove(['reports', 'lastSession', 'stats']);
    return true;
  JS
end
seed.call({})

priv = m.cmd('WebDriver:NewWindow', { 'type' => 'window', 'private' => true, 'focus' => true })['handle']
switch_to(m, priv)
is_private = chrome(m, 'const w = Services.wm.getMostRecentWindow("navigator:browser"); return PrivateBrowsingUtils.isWindowPrivate(w);')
check 'test window is a real private window', is_private
run = lambda do
  switch_to(m, priv)
  m.navigate("#{BASE}/playground.html")
  m.js("const a = document.getElementById('area'); a.value = ''; a.focus(); return true;")
  fire_command(m, 'toggle-typing')
  (wait_until(timeout: 20) { m.js("return document.getElementById('area').value") == TEXT } rescue false)
end
check 'the shortcut types in a private window', run.call
sleep 1
left = ext.call("return await browser.storage.local.get(['reports', 'lastSession', 'stats'])")
check 'no report or stats are kept from the private session', (left['reports'] || []).empty? && left['stats'].nil?, left.keys.inspect
check 'resume point keeps no page address', left['lastSession'].nil? || left['lastSession']['url'] == '', left['lastSession'].inspect

puts "\n\e[1mOpting in to private reports\e[0m"
seed.call({ privateReports: true })
check 'types again with reports kept', run.call
rep = (wait_until(timeout: 5) { ext.call("return ((await browser.storage.local.get('reports')).reports || [])[0] || null") } rescue nil)
check 'the report is saved and labelled as private', rep && rep['private'] == true && rep['host'] == 'Private window', rep&.slice('host', 'private').inspect

puts "Console: #{console_errors(m).reject { |x| x.include?('Ignored listener') }.uniq.first(5).inspect}"
m.quit
FileUtils.rm_rf(PROFILE)
puts($failures.empty? ? "\e[32mAll private-window checks passed.\e[0m" : "\e[31mFailed: #{$failures.join(', ')}\e[0m")
exit($failures.empty? ? 0 : 1)
