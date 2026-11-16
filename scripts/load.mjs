import { appendFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

// Load generator for the rollout demo. Keeps `--concurrency` requests in flight
// until SIGTERM/SIGINT and appends one line per request to `--out`: the HTTP status,
// or 000 when there was no response at all (refused, reset, timed out) — the
// curl convention. Nothing is retried: a retry would hide exactly what is measured.
//
//   node scripts/load.mjs --url http://127.0.0.1:30080/ --out /tmp/codes --concurrency 16 [--keepalive 0]
//
// By default connections are kept alive and reused, as a real client's would be; a
// pod that is draining answers with "Connection: close", and the next request opens
// a new one. --keepalive 0 opens a fresh connection per request, the way curl does.
//
// --rate caps requests per second across all workers (0 = as fast as they go). It
// matters without keep-alive: every request leaves a socket in TIME_WAIT for 2×MSL,
// and macOS has 16 383 ephemeral ports and an MSL of 15 s — past ~540 new
// connections a second the host runs out of ports (EADDRNOTAVAIL), and that would
// be counted as the cluster's failure.

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    out: { type: 'string' },
    concurrency: { type: 'string', default: '16' },
    'timeout-ms': { type: 'string', default: '5000' },
    keepalive: { type: 'string', default: '1' },
    rate: { type: 'string', default: '0' },
  },
});

if (!values.url || !values.out) {
  console.error('usage: node scripts/load.mjs --url <url> --out <file> [--concurrency 16] [--timeout-ms 5000] [--keepalive 1|0] [--rate 0]');
  process.exit(2);
}

const url = new URL(values.url);
const concurrency = Number(values.concurrency);
const timeoutMs = Number(values['timeout-ms']);
const intervalMs = Number(values.rate) > 0 ? 1000 / Number(values.rate) : 0;
let nextSlot = Date.now();
const agent = new http.Agent({ keepAlive: values.keepalive !== '0', maxSockets: concurrency });

writeFileSync(values.out, '');
let buffer = [];
let stopping = false;

function flush() {
  if (buffer.length === 0) return;
  appendFileSync(values.out, buffer.join('\n') + '\n');
  buffer = [];
}

function once() {
  return new Promise((resolve) => {
    const req = http.get(url, { agent, timeout: timeoutMs }, (res) => {
      res.resume();
      res.on('end', () => resolve(String(res.statusCode)));
      res.on('error', () => resolve('000'));
      res.on('close', () => resolve(res.complete ? String(res.statusCode) : '000'));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve('000'));
  });
}

async function pace() {
  if (intervalMs === 0) return;
  const slot = Math.max(Date.now(), nextSlot);
  nextSlot = slot + intervalMs;
  await sleep(slot - Date.now());
}

async function worker() {
  while (!stopping) {
    await pace();
    if (stopping) break;
    buffer.push(await once());
  }
}

const timer = setInterval(flush, 200);
const workers = Array.from({ length: concurrency }, worker);

const stop = () => {
  stopping = true;
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

await Promise.all(workers);
clearInterval(timer);
flush();
agent.destroy();
