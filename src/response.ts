import type http from 'node:http';

export function send(res: http.ServerResponse, status: number, payload: unknown): void {
  if (res.writableEnded) return;

  if (payload === undefined) {
    res.writeHead(204).end();
    return;
  }

  const json = JSON.stringify(payload);

  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
  });
  res.end(json);
}
