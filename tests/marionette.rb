# Minimal Marionette (Firefox remote protocol) client used by the end-to-end
# test-suite. Marionette speaks length-prefixed JSON over plain TCP, so this
# needs nothing beyond Ruby's standard library.
require 'socket'
require 'json'
require 'fileutils'
require 'base64'

class Marionette
  class Error < StandardError; end

  EXT_ID   = 'graphi@graphi.app'
  EXT_UUID = '5c0a7e1d-4b7e-4c55-9a8e-cade0ce0ce01'
  FIREFOX  = '/Applications/Firefox.app/Contents/MacOS/firefox'

  attr_reader :profile

  def self.prepare_profile(dir, port)
    FileUtils.mkdir_p(dir)
    prefs = {
      'marionette.port' => port,
      'browser.shell.checkDefaultBrowser' => false,
      'browser.startup.homepage_override.mstone' => 'ignore',
      'browser.startup.page' => 0,
      'datareporting.policy.dataSubmissionEnabled' => false,
      'toolkit.telemetry.reportingpolicy.firstRun' => false,
      'browser.aboutwelcome.enabled' => false,
      'trailhead.firstrun.didSeeAboutWelcome' => true,
      'extensions.webextensions.uuids' => JSON.generate(EXT_ID => EXT_UUID),
      'extensions.autoDisableScopes' => 0,
      'app.update.disabledForTesting' => true,
      'browser.tabs.warnOnClose' => false,
      'dom.disable_open_during_load' => false
    }
    File.write(File.join(dir, 'user.js'),
               prefs.map { |k, v| "user_pref(#{k.to_json}, #{v.to_json});" }.join("\n") + "\n")
  end

  def self.launch(profile:, port:, headless: true)
    args = [FIREFOX, '-profile', profile, '-marionette', '-no-remote', '-new-instance']
    args << '-headless' if headless
    pid = Process.spawn({ 'MOZ_REMOTE_ALLOW_SYSTEM_ACCESS' => '1' }, *args, out: File::NULL, err: File.join(profile, 'stderr.log'))
    client = nil
    60.times do
      begin
        client = new(port, pid)
        break
      rescue Errno::ECONNREFUSED, Errno::ECONNRESET, EOFError
        sleep 0.5
      end
    end
    raise Error, 'Firefox did not start' unless client
    client
  end

  def initialize(port, pid = nil)
    @pid = pid
    @sock = TCPSocket.new('127.0.0.1', port)
    @id = 0
    read_packet # server hello
  end

  def read_packet
    len = +''
    while (c = @sock.read(1)) != ':'
      raise EOFError if c.nil?
      len << c
    end
    JSON.parse(@sock.read(len.to_i))
  end

  def cmd(name, params = {})
    @id += 1
    body = JSON.generate([0, @id, name, params])
    @sock.write("#{body.bytesize}:#{body}")
    loop do
      _, id, err, res = read_packet
      next unless id == @id
      raise Error, "#{name}: #{err['error']}: #{err['message']}" if err
      return res
    end
  end

  def start_session
    cmd('WebDriver:NewSession', { 'capabilities' => { 'alwaysMatch' => { 'acceptInsecureCerts' => true } } })
  end

  def context(ctx)
    cmd('Marionette:SetContext', { 'value' => ctx })
  end

  def install_addon(path, temporary: true)
    cmd('Addon:Install', { 'path' => path, 'temporary' => temporary })['value']
  end

  def navigate(url)
    cmd('WebDriver:Navigate', { 'url' => url })
  rescue Error => e
    raise unless e.message.include?('discarded')
    # The tab's browsing context was swapped (process switch); re-attach.
    handle = cmd('WebDriver:GetWindowHandles').then { |r| r.is_a?(Hash) ? r['value'] : r }.first
    cmd('WebDriver:SwitchToWindow', { 'handle' => handle, 'focus' => true })
    cmd('WebDriver:Navigate', { 'url' => url })
  end

  # Runs `body` as an async function body; `args` is available as `args`.
  def js(body, args = [], timeout: 30_000)
    script = "const [__resolve] = [arguments[arguments.length-1]]; const args = Array.from(arguments).slice(0,-1);" \
             "(async () => { #{body} })().then(v => __resolve({ok:true,v}), e => __resolve({ok:false,e:String(e && ((e.message || '') + ' @ ' + (e.stack || '')) || e)}));"
    res = cmd('WebDriver:ExecuteAsyncScript', { 'script' => script, 'args' => args, 'scriptTimeout' => timeout })['value']
    raise Error, "JS error: #{res['e']}" unless res['ok']
    res['v']
  end

  def screenshot(path, full: false)
    data = cmd('WebDriver:TakeScreenshot', { 'full' => full, 'hash' => false })['value']
    File.binwrite(path, Base64.decode64(data))
  end

  def key_actions(keys)
    actions = keys.flat_map { |k| [{ 'type' => 'keyDown', 'value' => k }, { 'type' => 'keyUp', 'value' => k }] }
    cmd('WebDriver:PerformActions', { 'actions' => [{ 'type' => 'key', 'id' => 'kbd', 'actions' => actions }] })
    cmd('WebDriver:ReleaseActions')
  end

  def click(css)
    el = cmd('WebDriver:FindElement', { 'using' => 'css selector', 'value' => css })['value']
    cmd('WebDriver:ElementClick', { 'id' => el.values.first })
  end

  def quit
    return if @quit
    @quit = true
    cmd('Marionette:Quit', { 'flags' => ['eForceQuit'] }) rescue nil
    Process.wait(@pid) rescue nil if @pid
  end
end
