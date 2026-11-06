# Serves the test fixtures. Any /document/... or /presentation/... path returns
# the Google Docs simulator, so it can be reached as http://docs.google.com:PORT
# when the test profile forces DNS to 127.0.0.1.
require 'webrick'
port = (ARGV[0] || 8123).to_i
root = File.join(__dir__, 'fixtures')
server = WEBrick::HTTPServer.new(Port: port, BindAddress: '127.0.0.1', DocumentRoot: root,
                                 AccessLog: [], Logger: WEBrick::Log.new(File::NULL))
server.mount('/ext', WEBrick::HTTPServlet::FileHandler, File.expand_path('../extension', __dir__))
server.mount_proc('/document') { |_, res| res.content_type = 'text/html'; res.body = File.read(File.join(root, 'docs-sim.html')) }
server.mount_proc('/presentation') { |_, res| res.content_type = 'text/html'; res.body = File.read(File.join(root, 'docs-sim.html')) }
trap('TERM') { server.shutdown }
trap('INT') { server.shutdown }
server.start
