function handleRequest(request) {
  const { method, path, headers } = request;

  if (method === 'GET' && path === '/') {
    return {
      statusCode: 200,
      statusText: 'OK',
      contentType: 'text/plain',
      body: 'OK\n',
    };
  }

  if (method === 'GET' && path === '/headers') {
    const body = Object.entries(headers)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n');

    return {
      statusCode: 200,
      statusText: 'OK',
      contentType: 'text/plain',
      body: `${body}\n`,
    };
  }

  return {
    statusCode: 404,
    statusText: 'Not Found',
    contentType: 'text/plain',
    body: 'Not Found\n',
  };
}

module.exports = { handleRequest };
