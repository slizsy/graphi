# Renders Chrome's PNG icons from the SVG sources (Chrome can't use SVG icons).
# Uses headless Firefox, so it needs nothing else installed.
#
#   ruby scripts/make-icons.rb   → platforms/chrome/icons/*.png
require_relative '../tests/support/harness'
include Harness

OUT = File.join(ROOT, 'platforms', 'chrome', 'icons')
FileUtils.mkdir_p(OUT)
JOBS = { 'icon' => [16, 32, 48, 128], 'toolbar' => [16, 24, 32] }.freeze

start_server
profile = File.join(ENV['TMPDIR'] || '/tmp', "graphi-icons-#{Process.pid}")
m = boot(profile, port: 2958)
m.navigate("#{BASE}/playground.html")
JOBS.each do |name, sizes|
  sizes.each do |size|
    data = m.js(<<~JS, ["#{BASE}/ext/assets/icons/#{name}.svg", size])
      const [url, size] = args;
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = c.height = size;
      c.getContext('2d').drawImage(img, 0, 0, size, size);
      return c.toDataURL('image/png').split(',')[1];
    JS
    path = File.join(OUT, "#{name}-#{size}.png")
    File.binwrite(path, Base64.decode64(data))
    puts "  #{File.basename(path)}"
  end
end
m.quit
FileUtils.rm_rf(profile)
