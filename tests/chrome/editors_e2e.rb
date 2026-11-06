# The live editor demos from tests/firefox/editors_e2e.rb, in Chrome for
# Testing. Chromium handles execCommand differently from Firefox (no
# beforeinput), so this is where that difference really gets exercised.
# Requires network access.
#
#   ruby tests/chrome/editors_e2e.rb [name…]      TYPOS=8 to stress corrections
require_relative '../support/chromedriver'

ROOT = File.expand_path('../..', __dir__)
abort 'Chrome for Testing is missing: run scripts/get-chrome.sh first.' unless ChromeDriver.available?
TEXT = "Graphi was here.\nSecond line, typed live."
EDITORS = [
  ['ProseMirror', 'https://prosemirror.net/examples/basic/', '.ProseMirror'],
  ['CodeMirror 6', 'https://codemirror.net/', '.cm-content'],
  ['Lexical', 'https://playground.lexical.dev/', '.ContentEditable__root'],
  ['Slate', 'https://www.slatejs.org/examples/richtext', '[data-slate-editor]'],
  ['Quill', 'https://quilljs.com/', '.ql-editor'],
  ['Draft.js', 'https://draftjs.org/', '.public-DraftEditor-content'],
  # Monaco uses the EditContext API on Chromium instead of its textarea.
  ['Monaco (EditContext)', 'https://microsoft.github.io/monaco-editor/', '.monaco-editor .native-edit-context'],
].select { |name, *| ARGV.empty? || ARGV.any? { |a| name.downcase.include?(a.downcase) } }

$failures = []
def check(name, cond, detail = nil)
  puts cond ? "  \e[32m✓\e[0m #{name}" : "  \e[31m✗ #{name}\e[0m#{detail ? " — #{detail}" : ''}"
  $failures << name unless cond
end

def wait_until(timeout: 20)
  deadline = Time.now + timeout
  loop do
    v = yield
    return v if v
    raise "timed out after #{timeout}s" if Time.now > deadline
    sleep 0.25
  end
end

system(File.join(ROOT, 'scripts', 'build.sh'), 'chrome', out: File::NULL) or abort 'build failed'
tmp = File.join(ENV['TMPDIR'] || '/tmp', "graphi-chrome-editors-#{Process.pid}")
ext_dir = File.join(tmp, 'extension')
ext_id = ChromeDriver.prepare_extension(File.join(ROOT, 'dist', 'chrome'), ext_dir)
d = ChromeDriver.new(extension_dir: ext_dir, profile: File.join(tmp, 'profile'), port: 9518)
at_exit { d.quit; FileUtils.rm_rf(tmp) }

ctl = d.handle
d.navigate("chrome-extension://#{ext_id}/popup/popup.html?tab=-1")
wait_until { d.js('return document.documentElement.dataset.ready') == 'true' }
d.js(<<~JS, [TEXT, (ENV['TYPOS'] || '0').to_f])
  const now = Date.now();
  await chrome.storage.local.set({
    settings: { wpm: 200, variability: 0, typoRate: args[1], punctuationPauses: false, thinkingBreaks: 'off', countdown: 3,
                speedDrift: false, pauseWhenHidden: false, pauseOnInteraction: false, escToStop: true, showHud: true,
                correction: 'natural', docsMethod: 'auto' },
    library: { docs: [{ id: 'e', title: 'Editors', text: args[0], createdAt: now, updatedAt: now }], activeId: 'e' },
  });
  return true;
JS
page = nil
norm = ->(s) { s.to_s.gsub(/ /, ' ').gsub(/[ \t]+/, ' ').gsub(/\s*\n\s*/, "\n") }

puts "\n\e[1mLive editor frameworks (Chrome)\e[0m"
EDITORS.each do |name, url, sel|
  begin
    # A fresh window per editor: focus emulation doesn't reliably survive
    # several cross-site navigations in one window.
    if page
      d.switch_to(page)
      d.close_window
      d.switch_to(ctl)
    end
    page = d.new_window
    d.switch_to(page)
    d.navigate(url)
    d.emulate_focus
    wait_until(timeout: 25) { d.js('return !!document.querySelector(args[0])', [sel]) }
    sleep 1
    d.js(<<~JS, [sel])
      const el = document.querySelector(args[0]);
      el.scrollIntoView({ block: 'center' });
      el.focus();
      if (el.tagName !== 'TEXTAREA') {
        const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      }
      return true;
    JS
    sleep 0.3
    d.switch_to(ctl)
    res = d.js(<<~JS, [url])
      const t = (await chrome.tabs.query({})).find(x => (x.url || '').startsWith(new URL(args[0]).origin));
      return await chrome.runtime.sendMessage({ type: 'popup:start', tabId: t.id });
    JS
    # Starting from the control window takes focus away from the page; give
    # it back during the countdown, as it would be for a real user.
    d.switch_to(page)
    d.js('document.querySelector(args[0]).focus(); return true;', [sel])
    read = sel.include?('monaco') ? 'return window.monaco.editor.getModels()[0].getValue()' : 'return document.querySelector(args[0]).innerText'
    ok = (wait_until(timeout: 25) { norm.call(d.js(read, [sel])).include?(norm.call(TEXT)) } rescue false)
    got = norm.call(d.js(read, [sel]))
    if ENV['DEBUG'] && !ok
      d.switch_to(ctl)
      p d.js("const t = (await chrome.tabs.query({})).find(x => (x.url || '').startsWith(new URL(args[0]).origin)); return (await chrome.runtime.sendMessage({ type: 'popup:status', tabId: t.id })).snapshot;", [url])
      d.switch_to(page)
    end
    check "#{name}: text typed exactly", ok, (res && res['ok'] ? got[0, 70] : res).inspect
  rescue StandardError => e
    check "#{name}: page usable", false, e.message.lines.first
  end
end
exit($failures.empty? ? 0 : 1)
