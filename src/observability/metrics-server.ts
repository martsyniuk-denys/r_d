import { Server, createServer } from 'node:http';

import { registry } from './metrics';

// /metrics for a process that has no HTTP server of its own (the relay, the
// consumer). Started only when METRICS_PORT is set: the demos run several of
// these processes side by side, and a fixed port would make the second one fail.
export function startMetricsServer(name: string): Server | undefined {
  const raw = process.env.METRICS_PORT;
  if (raw === undefined || raw === '') return undefined;

  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`METRICS_PORT must be a TCP port, got '${raw}'`);
  }

  const server = createServer((req, res) => {
    if (req.method !== 'GET' || (req.url ?? '').split('?')[0] !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    registry
      .metrics()
      .then((body) => res.writeHead(200, { 'content-type': registry.contentType }).end(body))
      .catch(() => res.writeHead(500).end());
  });
  server.listen(port, () => console.error(`[${name}] metrics on :${port}/metrics`));
  // Not a reason to keep the process alive once its real work has stopped.
  server.unref();
  return server;
}
