# Shared helpers for the end-to-end tests.
require_relative 'marionette'

module Harness
  ROOT = File.expand_path('..', __dir__)
  EXT_DIR = File.join(ROOT, 'extension')
  PORT = 8123
  BASE = "http://127.0.0.1:#{PORT}"
  POPUP = "moz-extension://#{Marionette::EXT_UUID}/popup/popup.html"

  module_function

  def start_server
    pid = Process.spawn('ruby', File.join(__dir__, 'server.rb'), PORT.to_s, out: File::NULL, err: File::NULL)
    at_exit { Process.kill('TERM', pid) rescue nil }
    sleep 0.6
    pid
  end

  def boot(profile, port: 2940, fresh: true, headless: true, extra_prefs: {})
    FileUtils.rm_rf(profile) if fresh
    Marionette.prepare_profile(profile, port)
    unless extra_prefs.empty?
      File.open(File.join(profile, 'user.js'), 'a') do |f|
        extra_prefs.each { |k, v| f.puts "user_pref(#{k.to_json}, #{v.to_json});" }
      end
    end
    m = Marionette.launch(profile: profile, port: port, headless: headless)
    at_exit { m.quit }
    m.start_session
    m
  end

  def install(m)
    m.context('chrome')
    id = m.install_addon(EXT_DIR, temporary: true)
    m.context('content')
    sleep 0.8
    id
  end

  # --- chrome-privileged helpers -------------------------------------------
  def chrome(m, body, args = [])
    m.context('chrome')
    v = m.js(body, args)
    m.context('content')
    v
  end

  EXT = 'const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");' \
        'const ext = ExtensionParent.GlobalManager.getExtension("graphi@graphi.app");' \
        'const win = Services.wm.getMostRecentWindow("navigator:browser");'

  def selected_tab_id(m)
    chrome(m, "#{EXT} return ext.tabManager.getWrapper(win.gBrowser.selectedTab).id;")
  end

  def grant_active_tab(m)
    chrome(m, "#{EXT} ext.tabManager.addActiveTabPermission(win.gBrowser.selectedTab); return true;")
  end

  # Fires a keyboard command exactly like Firefox does for a real key press.
  def fire_command(m, name)
    chrome(m, <<~JS, [name])
      #{EXT}
      const name = args[0];
      const keyset = win.document.getElementById("ext-keyset-id-graphi_graphi_app");
      const cmds = await ext.shortcuts.commands;
      const sc = (cmds.get ? cmds.get(name) : cmds[name])?.shortcut || "";
      const letter = sc.split("+").pop();
      const keys = [...keyset.children].filter(k => (k.getAttribute("key") || "").toUpperCase() === letter.toUpperCase());
      if (!keys.length) throw new Error("no key for " + name + ": " + [...keyset.children].map(k => [...k.attributes].map(a => a.name+"="+a.value).join(" ")).join(" // "));
      keys[0].doCommand();
      return keys[0].id;
    JS
  end

  def new_tab(m, url)
    m.cmd('WebDriver:NewWindow', { 'type' => 'tab', 'focus' => true }).then { |r| m.cmd('WebDriver:SwitchToWindow', { 'handle' => r['handle'], 'focus' => true }); r['handle'] }
                                                                          .tap { m.navigate(url) }
  end

  def switch_to(m, handle)
    m.cmd('WebDriver:SwitchToWindow', { 'handle' => handle, 'focus' => true })
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
end

# Tiny assertion helpers with readable output.
$failures = []
def check(name, cond, detail = nil)
  if cond
    puts "  \e[32m✓\e[0m #{name}"
  else
    puts "  \e[31m✗ #{name}\e[0m#{detail ? " — #{detail}" : ''}"
    $failures << name
  end
end

module Harness
  module_function

  # Error/warning messages from the browser console (all processes), filtered
  # to anything mentioning Graphi's extension or moz-extension URLs.
  def console_errors(m, all: false)
    chrome(m, <<~JS, [all])
      const out = [];
      for (const msg of Services.console.getMessageArray() || []) {
        let s = '';
        if (msg instanceof Ci.nsIScriptError) {
          if (msg.flags & Ci.nsIScriptError.warningFlag && !args[0]) continue;
          s = `${msg.errorMessage} @ ${msg.sourceName}:${msg.lineNumber}`;
        } else s = msg.message;
        if (args[0] || /moz-extension|graphi|uncaught/i.test(s)) out.push(s);
      }
      return out;
    JS
  end
end
