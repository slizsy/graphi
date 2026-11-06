# A very small WebDriver client for chromedriver, plus a way to load Graphi's
# Chrome build into Chrome for Testing. Standard library only.
require 'net/http'
require 'json'
require 'openssl'
require 'digest'
require 'fileutils'

class ChromeDriver
  class Error < StandardError; end

  BROWSERS = File.expand_path('../.browsers', __dir__)

  def self.available?
    File.exist?(File.join(BROWSERS, 'chromedriver')) && File.exist?(File.join(BROWSERS, 'chrome-path'))
  end

  # Copies the Chrome build and adds two things automation needs: a fixed key
  # (so the extension ID is known up front) and host access (because a test
  # can't click the toolbar button to grant activeTab). The shipped manifest
  # has neither.
  def self.prepare_extension(src, dest)
    FileUtils.rm_rf(dest)
    FileUtils.mkdir_p(File.dirname(dest))
    FileUtils.cp_r(src, dest)
    key = OpenSSL::PKey::RSA.new(2048)
    der = key.public_key.to_der
    manifest_path = File.join(dest, 'manifest.json')
    manifest = JSON.parse(File.read(manifest_path))
    manifest['key'] = [der].pack('m0')
    manifest['host_permissions'] = ['<all_urls>']
    File.write(manifest_path, JSON.pretty_generate(manifest))
    Digest::SHA256.hexdigest(der)[0, 32].tr('0-9a-f', 'a-p')
  end

  def initialize(extension_dir:, profile:, port: 9517, extra_args: [])
    @port = port
    @pid = Process.spawn(File.join(BROWSERS, 'chromedriver'), "--port=#{port}", out: File::NULL, err: File::NULL)
    wait_for_driver
    args = [
      '--headless=new', '--no-first-run', '--no-default-browser-check', '--window-size=1280,900',
      "--user-data-dir=#{profile}", "--load-extension=#{extension_dir}", "--disable-extensions-except=#{extension_dir}",
      *extra_args
    ]
    res = post('/session', capabilities: { alwaysMatch: {
      browserName: 'chrome',
      'goog:chromeOptions' => { binary: File.read(File.join(BROWSERS, 'chrome-path')).strip, args: args,
                                excludeSwitches: ['disable-extensions', 'enable-automation'] },
    } })
    @session = res['sessionId']
  end

  def wait_for_driver
    50.times do
      begin
        return if get('/status')['ready']
      rescue Errno::ECONNREFUSED, EOFError
        nil
      end
      sleep 0.2
    end
    raise Error, 'chromedriver did not start'
  end

  def request(verb, path, body = nil)
    http = Net::HTTP.new('127.0.0.1', @port)
    http.read_timeout = 120
    req = verb == :get ? Net::HTTP::Get.new(path) : verb == :delete ? Net::HTTP::Delete.new(path) : Net::HTTP::Post.new(path)
    if body
      req['Content-Type'] = 'application/json'
      req.body = JSON.generate(body)
    end
    data = JSON.parse(http.request(req).body)
    value = data.key?('value') ? data['value'] : data
    raise Error, "#{path}: #{value['error']}: #{value['message']&.lines&.first}" if value.is_a?(Hash) && value['error']
    value
  end

  def get(path)
    request(:get, path)
  end

  def post(path, body = {})
    request(:post, path, body)
  end

  def s(path)
    "/session/#{@session}#{path}"
  end

  def navigate(url)
    post(s('/url'), url: url)
  end

  def handle
    get(s('/window'))
  end

  def handles
    get(s('/window/handles'))
  end

  def switch_to(h)
    post(s('/window'), handle: h)
  end

  def new_window
    post(s('/window/new'), type: 'window')['handle']
  end

  def close_window
    request(:delete, s('/window'))
  end

  # Runs `body` as an async function body; `args` is available as `args`.
  def js(body, args = [])
    script = "const done = arguments[arguments.length-1]; const args = Array.from(arguments).slice(0,-1);" \
             "(async () => { #{body} })().then(v => done({ok:true,v}), e => done({ok:false,e:String(e && (e.message || e))}));"
    res = post(s('/execute/async'), script: script, args: args)
    raise Error, "JS error: #{res['e']}" unless res['ok']
    res['v']
  end

  # Raw Chrome DevTools Protocol command for the current window.
  def cdp(cmd, params = {})
    post(s('/goog/cdp/execute'), cmd: cmd, params: params)
  end

  # Headless windows never have OS focus, and some editors (Monaco) ignore
  # input while unfocused. Make the current page behave as if it were focused.
  def emulate_focus
    cdp('Emulation.setFocusEmulationEnabled', enabled: true)
  end

  def screenshot(path)
    File.binwrite(path, get(s('/screenshot')).unpack1('m'))
  end

  def quit
    return if @quit
    @quit = true
    request(:delete, s('')) rescue nil
    Process.kill('TERM', @pid) rescue nil
    Process.wait(@pid) rescue nil
  end
end
