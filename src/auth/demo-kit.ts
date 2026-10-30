import { ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { DataSource } from 'typeorm';

import { dataSourceOptions } from '../data-source';
import { UserRole } from '../entities/user.entity';
import { hashPassword } from './password';

export { Invariants, report, runDemo } from '../common/demo-output';

// What demo:auth, demo:reuse and demo:rbac share: the schema brought up to date,
// the demo's own accounts reset, and the real API (dist/main.js) started as a
// child process on a free port — and always killed, however the demo ends.

export interface Account {
  id: string;
  email: string;
  password: string;
  role: UserRole;
}

export interface Reply<T = unknown> {
  status: number;
  body: T;
}

const live = new Set<ChildProcess>();
process.on('exit', () => {
  for (const child of live) child.kill('SIGKILL');
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => process.exit(130));
}

export async function openDatabase(): Promise<DataSource> {
  const dataSource = new DataSource({ ...dataSourceOptions, logging: ['error'] });
  await dataSource.initialize();
  await dataSource.runMigrations({ transaction: 'each' });
  return dataSource;
}

// One account per (demo, label), reused across runs: the row is upserted with a
// fresh password, and everything it left behind last time — its refresh tokens,
// the products it created — is deleted. Each demo owns its own emails, so one
// demo's reset never touches another's state.
export async function resetAccount(
  dataSource: DataSource,
  demo: string,
  label: string,
  role: UserRole,
): Promise<Account> {
  const email = `${demo}-${label}@auth-demo.test`;
  const password = randomBytes(18).toString('base64url');

  const [{ id }]: { id: string }[] = await dataSource.query(
    `INSERT INTO users (email, display_name, country, balance_minor, role, password_hash)
     VALUES ($1, $2, 'UA', 0, $3, $4)
     ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role, password_hash = EXCLUDED.password_hash
     RETURNING id`,
    [email, `Auth demo ${label}`, role, await hashPassword(password)],
  );
  await dataSource.query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [id]);
  await dataSource.query(
    `DELETE FROM products p WHERE p.seller_id = $1 AND NOT EXISTS (SELECT 1 FROM order_items i WHERE i.product_id = p.id)`,
    [id],
  );

  return { id, email, password, role };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export class Api {
  readonly log: string[] = [];

  private constructor(
    private readonly child: ChildProcess,
    readonly url: string,
  ) {}

  // The same entry point as npm run start, with the environment this demo was
  // started with — which is the store's, through scripts/with-secrets.sh.
  static async start(): Promise<Api> {
    const port = await freePort();
    const child = spawn(process.execPath, [join(__dirname, '..', 'main.js')], {
      env: { ...process.env, PORT: String(port), NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    live.add(child);
    child.on('exit', () => live.delete(child));

    const api = new Api(child, `http://127.0.0.1:${port}`);
    for (const stream of [child.stdout!, child.stderr!]) {
      createInterface({ input: stream }).on('line', (line) => api.log.push(line));
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the API did not listen within 20 s:\n${api.log.join('\n')}`)), 20_000);
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`the API exited with ${code} before listening:\n${api.log.join('\n')}`));
      });
      const poll = async (): Promise<void> => {
        try {
          if ((await fetch(`${api.url}/health`)).ok) {
            clearTimeout(timer);
            child.removeAllListeners('exit');
            child.on('exit', () => live.delete(child));
            return resolve();
          }
        } catch {
          // not listening yet
        }
        setTimeout(poll, 150);
      };
      void poll();
    });

    return api;
  }

  async call<T = Record<string, unknown>>(
    method: string,
    path: string,
    options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Reply<T>> {
    const response = await fetch(this.url + path, {
      method,
      headers: {
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` }),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: response.status, body: body as T };
  }

  stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      this.child.once('exit', () => resolve());
      this.child.kill('SIGTERM');
    });
  }
}

export interface Pair {
  access_token: string;
  refresh_token: string;
}

export const login = (api: Api, account: Account): Promise<Reply<Pair>> =>
  api.call<Pair>('POST', '/auth/login', { body: { email: account.email, password: account.password } });

export const refresh = (api: Api, refreshToken: string): Promise<Reply<Pair>> =>
  api.call<Pair>('POST', '/auth/refresh', { body: { refresh_token: refreshToken } });

// Exactly the three lines from the assignment: payload swapped, signature kept.
// No key is needed to do this, which is the point — only a verifier that checks
// the signature notices.
export function tamper(accessToken: string, claims: Record<string, unknown>): string {
  const parts = accessToken.split('.');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as Record<string, unknown>;
  parts[1] = Buffer.from(JSON.stringify({ ...payload, ...claims })).toString('base64url');
  return parts.join('.');
}

export function claimsOf(accessToken: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString()) as Record<string, unknown>;
}
