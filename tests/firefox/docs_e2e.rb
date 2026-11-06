# Google Docs adapter tests against the local Docs simulator.
#
# The test profile resolves every hostname to 127.0.0.1, so the simulator is
# served as http://docs.google.com:8123/document/… — the adapter's real
# hostname/path detection is exercised, not bypassed.
require_relative '../support/harness'
include Harness

PROFILE = File.join(ENV['TMPDIR'] || '/tmp', "graphi-docs-#{Process.pid}")
TEXT = "Docs typing works.\nSecond paragraph, with typos fixed."

start_server
m = boot(PROFILE, port: 2944, extra_prefs: {
  'network.dns.forceResolve' => '127.0.0.1',
  'network.stricttransportsecurity.preloadlist' => false,
  'dom.security.https_first' => false,
  'dom.security.https_only_mode' => false,
  'network.proxy.type' => 0,
})
install(m)
ctl = m.cmd('WebDriver:GetWindowHandle')['value']
m.navigate("#{POPUP}?tab=-1")
page = m.cmd('WebDriver:NewWindow', { 'type' => 'window', 'focus' => true })['handle']

def configure(m, ctl, page, settings)
  m.cmd('WebDriver:SwitchToWindow', { 'handle' => ctl, 'focus' => true })
  m.js(<<~JS, [settings, TEXT])
    const now = Date.now();
    await browser.storage.local.set({
      settings: { wpm: 220, variability: 0, typoRate: 0, punctuationPauses: false, thinkingBreaks: 'off', countdown: 0,
                  speedDrift: false, pauseWhenHidden: false, pauseOnInteraction: true, escToStop: true, showHud: true,
                  correction: 'natural', docsMethod: 'auto', ...args[0] },
      library: { docs: [{ id: 'd', title: 'Docs', text: args[1], createdAt: now, updatedAt: now }], activeId: 'd' },
    });
    return true;
  JS
  m.cmd('WebDriver:SwitchToWindow', { 'handle' => page, 'focus' => true })
end

puts "\n\e[1mGoogle Docs adapter (simulated editor on docs.google.com)\e[0m"
[
  ['textinput', {}, 'legacy textInput events'],
  ['keypress', {}, 'keypress events'],
  ['input', {}, 'beforeinput from execCommand'],
  ['textinput', { typoRate: 8 }, 'textInput with typos + backspace corrections'],
  ['keypress', { docsMethod: 'keypress' }, 'forced "Keys" method'],
].each do |accept, settings, label|
  configure(m, ctl, page, settings)
  m.navigate("http://docs.google.com:#{PORT}/document/d/test/edit?accept=#{accept}")
  sleep 0.5
  fire_command(m, 'toggle-typing')
  got = begin
    wait_until(timeout: 40) { (v = m.js('return window.__docText()')) == TEXT ? v : nil }
  rescue RuntimeError
    m.js('return window.__docText()')
  end
  check "#{label}: document text is exact", got == TEXT, got.inspect
end

# Slides share the same input layer.
configure(m, ctl, page, {})
m.navigate("http://docs.google.com:#{PORT}/presentation/d/test/edit?accept=textinput")
sleep 0.5
fire_command(m, 'toggle-typing')
got = (wait_until(timeout: 30) { m.js('return window.__docText()') == TEXT } rescue false)
check 'Slides path types exactly', got

puts "Console: #{console_errors(m).uniq.first(5).inspect}"
m.quit
FileUtils.rm_rf(PROFILE)
puts($failures.empty? ? "\e[32mAll Docs checks passed.\e[0m" : "\e[31mFailed: #{$failures.join(', ')}\e[0m")
exit($failures.empty? ? 0 : 1)
