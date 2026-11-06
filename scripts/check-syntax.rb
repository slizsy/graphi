# Parses every JavaScript file in src/ with the browser's own parser, so a
# syntax error is caught before any test or release. Needs Firefox only.
#
#   ruby scripts/check-syntax.rb
require_relative '../tests/support/harness'
include Harness

start_server
profile = File.join(ENV['TMPDIR'] || '/tmp', "graphi-syntax-#{Process.pid}")
m = boot(profile, port: 2960)
m.navigate("#{BASE}/playground.html")
files = Dir.chdir(File.join(ROOT, 'src')) { Dir['**/*.js'].sort }
# Content scripts are classic scripts; everything else is an ES module.
classic = ->(f) { f.start_with?('content/') || f == 'shared/browser-shim.js' }
bad = m.js(<<~JS, [files.map { |f| [f, File.read(File.join(ROOT, 'src', f)), classic.call(f)] }])
  const out = [];
  for (const [name, code, isClassic] of args[0]) {
    try {
      if (isClassic) new Function(code);
      // A module can't go through new Function; parse it as a module script.
      else {
        const s = document.createElement('script');
        s.type = 'module';
        const err = await new Promise((resolve) => {
          const onErr = (e) => { if (e.filename && e.filename.startsWith('blob:')) resolve(e.message); };
          window.addEventListener('error', onErr, { once: true });
          // Strip imports: we only want to know the file parses.
          const body = code.replace(/^\\s*import\\s[^;]+;/gm, '').replace(/^\\s*export\\s+(?=(const|function|async|class|let))/gm, '').replace(/^export\\s*\\{[^}]*\\};?/gm, '');
          s.src = URL.createObjectURL(new Blob([`if (false) { ${body}\\n}`], { type: 'text/javascript' }));
          s.onload = () => resolve(null);
          s.onerror = () => resolve('failed to load');
          document.head.append(s);
        });
        if (err) out.push(`${name}: ${err}`);
      }
    } catch (e) {
      out.push(`${name}: ${e.message}`);
    }
  }
  return out;
JS
m.quit
FileUtils.rm_rf(profile)
if bad.empty?
  puts "Syntax OK (#{files.length} files)"
else
  puts bad
  exit 1
end
