// What demo:logs, demo:metrics and demo:trace share: the real API (dist/main.js,
// the entry point of npm run start) started as a child process with its stdout
// and stderr kept line by line, a buyer with a token and a product to order.
//
// Every run starts from nothing: a fresh process (so its counters and its
// in-memory orders are zero), the demo's accounts reset with a new password, the
// demo product recreated. The process is always killed, also on Ctrl-C.

import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);

const { openDatabase, resetAccount } = require(join(ROOT, 'dist', 'auth', 'demo-kit.js'));
export const { Invariants, report } = require(join(ROOT, 'dist', 'common', 'demo-output.js'));
const { DURATION_BUCKETS } = require(join(ROOT, 'dist', 'observability', 'metrics.js'));

// The largest finite le the API's histogram has, as the code defines it.
export const DURATION_TOP = Math.max(...DURATION_BUCKETS);

// The port Prometheus scrapes (observability/prometheus/prometheus.yml), so the
// dashboard shows what the demos send while they run.
export const APP_PORT = Number(process.env.OBS_APP_PORT ?? 22910);

const live = new Set();
process.on('exit', () => {
  for (const child of live) child.kill('SIGKILL');
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130));

export function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set — it comes from the store (npm run demo:… goes through scripts/with-secrets.sh), or export it with SKIP_VAULT=1`);
  }
  return value.replace(/\/+$/, '');
}

// W3C Trace Context, as a client that is itself traced would send it:
// 00-<32 hex trace-id>-<16 hex parent span id>-<flags, 01 = sampled>.
export function traceparent() {
  const traceId = randomBytes(16).toString('hex');
  const parentId = randomBytes(8).toString('hex');
  return { header: `00-${traceId}-${parentId}-01`, traceId, parentId };
}

export const idempotencyKey = () => `obs-${randomUUID()}`;

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

export class ObservedApi {
  /** @type {{ stream: 'stdout' | 'stderr', text: string, json: Record<string, unknown> | null }[]} */
  lines = [];

  constructor(child, url) {
    this.child = child;
    this.url = url;
  }

  static async start(env = {}) {
    if (!(await portIsFree(APP_PORT))) {
      throw new Error(`port ${APP_PORT} is busy — another demo or an npm run start? (OBS_APP_PORT moves it, but then Prometheus does not see the run)`);
    }
    const child = spawn(process.execPath, [join(ROOT, 'dist', 'main.js')], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(APP_PORT),
        LOG_LEVEL: 'debug',
        FAULT_INJECTION: '1',
        // export every 200 ms instead of every second: the trace demo polls the
        // backend, and a shorter batch delay is a shorter wait
        OTEL_BSP_SCHEDULE_DELAY: '200',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    live.add(child);
    child.on('exit', () => live.delete(child));

    const api = new ObservedApi(child, `http://127.0.0.1:${APP_PORT}`);
    for (const stream of ['stdout', 'stderr']) {
      createInterface({ input: child[stream] }).on('line', (text) => {
        let json = null;
        try {
          const parsed = JSON.parse(text);
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed;
        } catch {
          // stays null: a line that is not a JSON object
        }
        api.lines.push({ stream, text, json });
      });
    }

    const deadline = Date.now() + 20_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`the API exited with ${child.exitCode}:\n${api.dump()}`);
      try {
        if ((await fetch(`${api.url}/health`)).ok) break;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error(`the API did not listen within 20 s:\n${api.dump()}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return api;
  }

  dump() {
    return this.lines.map((line) => line.text).join('\n');
  }

  async call(method, path, { token, body, headers = {} } = {}) {
    const started = performance.now();
    const response = await fetch(this.url + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed, ms: performance.now() - started };
  }

  async scrape() {
    const response = await fetch(`${this.url}/metrics`);
    return parseExposition(await response.text());
  }

  // The request line is written on 'finish', which can land just after the client
  // has its response; wait for it instead of reading the log too early.
  async waitForLines(predicate, count, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (this.lines.filter((line) => line.json !== null && predicate(line.json)).length < count) {
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
  }

  stop() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.child.kill('SIGKILL'), 10_000);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      this.child.kill('SIGTERM');
    });
  }
}

// Prometheus text format → [{ name, labels, value }]. Comments and blank lines skipped.
export function parseExposition(text) {
  const samples = [];
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)/.exec(line);
    if (match === null) continue;
    const labels = {};
    for (const pair of (match[2] ?? '').matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) labels[pair[1]] = pair[2];
    samples.push({ name: match[1], labels, value: Number(match[3]) });
  }
  return samples;
}

export function sum(samples, name, where = () => true) {
  return samples.filter((s) => s.name === name && where(s.labels)).reduce((total, s) => total + s.value, 0);
}

// The demo's buyer (logs in, places orders) and seller (owns the one product
// the orders are for). Both are reset every run.
export async function prepare(demo) {
  const dataSource = await openDatabase();
  try {
    const buyer = await resetAccount(dataSource, demo, 'buyer', 'buyer');
    const seller = await resetAccount(dataSource, demo, 'seller', 'seller');
    const [{ id }] = await dataSource.query(
      `INSERT INTO products (seller_id, name, description, price_minor, currency, status, stock)
       VALUES ($1, $2, '', 12900, 'UAH', 'active', 1000) RETURNING id`,
      [seller.id, `${demo} product`],
    );
    return { buyer, productId: `p_${id}` };
  } finally {
    await dataSource.destroy();
  }
}

export async function login(api, account) {
  const reply = await api.call('POST', '/auth/login', { body: { email: account.email, password: account.password } });
  if (reply.status !== 200) throw new Error(`login as ${account.email} answered ${reply.status}:\n${api.dump()}`);
  return reply.body.access_token;
}

export function runDemo(main) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
