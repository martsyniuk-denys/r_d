const { parseRequest } = require('./parseRequest');
const { handleRequest } = require('./handleRequest');
const { buildResponse } = require('./buildResponse');

const HEADER_TERMINATOR = '\r\n\r\n';

function attachConnectionHandler(socket) {
  let buffer = Buffer.alloc(0);
  let handled = false;

  socket.on('data', (chunk) => {
    if (handled) return;

    buffer = Buffer.concat([buffer, chunk]);

    const headerEnd = buffer.indexOf(HEADER_TERMINATOR);
    if (headerEnd === -1) return;

    const headerText = buffer.subarray(0, headerEnd).toString('utf8');
    const parsed = parseRequest(headerText);

    if (!parsed) {
      handled = true;
      socket.end(buildResponse({
        statusCode: 400,
        statusText: 'Bad Request',
        contentType: 'text/plain',
        body: 'Bad Request\n',
      }));
      return;
    }

    const bodyStart = headerEnd + HEADER_TERMINATOR.length;
    const contentLength = Number.parseInt(parsed.headers['content-length'], 10) || 0;

    if (buffer.length - bodyStart < contentLength) return;

    handled = true;
    const body = buffer.subarray(bodyStart, bodyStart + contentLength).toString('utf8');
    const response = handleRequest({ ...parsed, body });
    socket.end(buildResponse(response));
  });

  socket.on('error', () => {
    socket.destroy();
  });
}

module.exports = { attachConnectionHandler };
