const net = require('net');
const { attachConnectionHandler } = require('./connectionHandler');

const PORT = process.env.PORT || 3000;

const server = net.createServer((socket) => {
  attachConnectionHandler(socket);
});

server.listen(PORT, () => {
  console.log(`HTTP server (net.createServer) listening on http://localhost:${PORT}`);
});
