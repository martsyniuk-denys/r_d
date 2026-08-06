function buildResponse({ statusCode, statusText, contentType, body }) {
  const bodyBuffer = Buffer.from(body, 'utf8');

  const head = [
    `HTTP/1.1 ${statusCode} ${statusText}`,
    `Content-Type: ${contentType}`,
    `Content-Length: ${bodyBuffer.length}`,
    'Connection: close',
    '',
    '',
  ].join('\r\n');

  return Buffer.concat([Buffer.from(head, 'utf8'), bodyBuffer]);
}

module.exports = { buildResponse };
