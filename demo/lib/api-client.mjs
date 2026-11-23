// A thin HTTP client for the demos that run against a live API — compose, a local
// `npm start`, or the cluster — chosen by BASE_URL. Nothing here reaches into the
// database: what the demos prove, they prove through the public API.
import { createHmac, randomUUID } from 'node:crypto';

export const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

// Fixture accounts from src/seed.ts (npm run seed / the compose `migrate` service).
export const SEED_PASSWORD = process.env.SEED_PASSWORD ?? 'marketplace-dev-password';
export const BUYER = process.env.DEMO_BUYER ?? 'olena.kovalenko@example.com';
export const OTHER_BUYER = process.env.DEMO_OTHER_BUYER ?? 'andrii.shevchenko@example.com';
export const ADMIN = process.env.DEMO_ADMIN ?? 'ops.admin@example.com';

export async function call(method, path, { token, body, headers = {}, raw } = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await response.text();
  let json;
  try {
    json = text === '' ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, body: json };
}

export async function login(email) {
  const { status, body } = await call('POST', '/auth/login', { body: { email, password: SEED_PASSWORD } });
  if (status !== 200) throw new Error(`login ${email}: HTTP ${status} — is the API up at ${BASE_URL} and seeded?`);
  return body.access_token;
}

// Active products with enough stock for `qty`, from the public catalogue.
export async function productsInStock(count) {
  const { body } = await call('GET', '/products?limit=100');
  const items = body?.items ?? [];
  if (items.length < count) throw new Error(`need ${count} products in the catalogue, found ${items.length}`);
  return items.slice(0, count).map((p) => p.id);
}

export function placeOrder(token, items, key = randomUUID()) {
  return call('POST', '/orders', { token, body: { items }, headers: { 'idempotency-key': key } });
}

// What the provider sends: a signed body. The signature is over these exact bytes.
export function webhook(secret, payload, { signWith = secret } = {}) {
  const raw = JSON.stringify(payload);
  const signature = 'sha256=' + createHmac('sha256', signWith).update(raw).digest('hex');
  return call('POST', '/payments/webhook', { raw, headers: { 'x-signature': signature } });
}

export function webhookSecret() {
  const secret = process.env.PAYMENT_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error('PAYMENT_WEBHOOK_SECRET is not set — run through npm (scripts/with-secrets.sh), or export it with SKIP_VAULT=1');
  }
  return secret;
}

// Polls until the order reaches `status` or the deadline passes; the background
// part is asynchronous, so the demo waits for it the way a client would.
export async function waitForStatus(token, orderId, status, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await call('GET', `/orders/${orderId}`, { token });
    if (body?.status === status || Date.now() > deadline) return body?.status;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export class Invariants {
  failures = [];

  check(label, ok, detail) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}: ${detail}`);
    if (!ok) this.failures.push(label);
  }
}

export function report(values) {
  for (const [key, value] of Object.entries(values)) console.log(`${key}=${value}`);
}

export function run(main) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
