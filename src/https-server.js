const tls = require('tls');
const fs = require('fs');
const path = require('path');
const { attachConnectionHandler } = require('./connectionHandler');

const PORT = process.env.HTTPS_PORT || 3443;
const CERT_DIR = path.join(__dirname, '..', 'certs');
const KEY_PATH = path.join(CERT_DIR, 'key.pem');
const CERT_PATH = path.join(CERT_DIR, 'cert.pem');

if (!fs.existsSync(KEY_PATH) || !fs.existsSync(CERT_PATH)) {
  console.error(
    'Missing certs/key.pem or certs/cert.pem. Generate them first:\n' +
    '  npm run gen-cert'
  );
  process.exit(1);
}

const options = {
  key: fs.readFileSync(KEY_PATH),
  cert: fs.readFileSync(CERT_PATH),
};

const server = tls.createServer(options, (socket) => {
  attachConnectionHandler(socket);
});

server.listen(PORT, () => {
  console.log(`HTTPS server (tls.createServer) listening on https://localhost:${PORT}`);
});
