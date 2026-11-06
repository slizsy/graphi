# Real-world editor compatibility: drives the live demo pages of popular
# rich-text / code editor frameworks. Requires network access.
require_relative '../support/harness'
include Harness

PROFILE = File.join(ENV['TMPDIR'] || '/tmp', "graphi-editors-#{Process.pid}")
TEXT = "Graphi was here.\nSecond line, typed live."

EDITORS = [
  ['ProseMirror', 'https://prosemirror.net/examples/basic/', '.ProseMirror'],
  ['CodeMirror 6', 'https://codemirror.net/', '.cm-content'],
  ['Lexical', 'https://playground.lexical.dev/', '.ContentEditable__root'],
  ['Slate', 'https://www.slatejs.org/examples/richtext', '[data-slate-editor]'],
  ['Quill', 'https://quilljs.com/', '.ql-editor'],
  ['Draft.js', 'https://draftjs.org/', '.public-DraftEditor-content'],
  ['Monaco (textarea)', 'https://microsoft.github.io/monaco-editor/', '.monaco-editor textarea'],
].select { |name, *| ARGV.empty? || ARGV.any? { |a| name.downcase.include?(a.downcase) } }

m = boot(PROFILE, port: 2946)
install(m)
ctl = m.cmd('WebDriver:GetWindowHandle')['value']
m.navigate("#{POPUP}?tab=-1")
m.js(<<~JS.sub('ENV_TYPOS', (ENV['TYPOS'] || '0').to_s), [TEXT])
  const now = Date.now();
  await browser.storage.local.set({
    settings: { wpm: 200, variability: 0, typoRate: Number(ENV_TYPOS), punctuationPauses: false, thinkingBreaks: 'off', countdown: 0,
                speedDrift: false, pauseWhenHidden: false, pauseOnInteraction: false, escToStop: true, showHud: true,
                correction: 'natural', docsMethod: 'auto' },
    library: { docs: [{ id: 'e', title: 'Editors', text: args[0], createdAt: now, updatedAt: now }], activeId: 'e' },
  });
  return true;
JS
page = m.cmd('WebDriver:NewWindow', { 'type' => 'window', 'focus' => true })['handle']
m.cmd('WebDriver:SwitchToWindow', { 'handle' => page, 'focus' => true })

norm = ->(s) { s.to_s.gsub(/ /, ' ').gsub(/[ \t]+/, ' ').gsub(/\s*\n\s*/, "\n") }

puts "\n\e[1mLive editor frameworks\e[0m"
EDITORS.each do |name, url, sel|
  begin
    m.navigate(url)
    wait_until(timeout: 25) { m.js('return !!document.querySelector(args[0])', [sel]) }
    sleep 1
    # Put the caret at the very end of the editor, as a user clicking there would.
    m.js(<<~JS, [sel])
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
    fire_command(m, 'toggle-typing')
    target = sel
    read = sel.include?('monaco') ? 'return window.monaco.editor.getModels()[0].getValue()' : 'return document.querySelector(args[0]).innerText'
    ok = begin
      wait_until(timeout: 25) { norm.call(m.js(read, [target])).include?(norm.call(TEXT)) }
    rescue RuntimeError
      false
    end
    got = norm.call(m.js(read, [target]))
    tail = got[-60..] || got
    check "#{name}: text typed exactly", ok, tail.inspect
    m.screenshot(File.join(PROFILE, "..", "editor-#{name.downcase.gsub(/\W+/, '-')}.png")) unless ok
  rescue StandardError => e
    check "#{name}: page usable", false, e.message.lines.first
  end
end

puts "Console: #{console_errors(m).reject { |s| s.include?('Ignored listener') }.uniq.first(5).inspect}"
m.quit
FileUtils.rm_rf(PROFILE)
exit($failures.empty? ? 0 : 1)
