/**
 * Runs the option B acceptance criteria: boots the compiled Nest app on a free
 * port and verifies that the express-openapi-validator boundary really does
 * reject anything that contradicts the spec. Run with: npm run smoke
 */
import { createApp } from '../dist/bootstrap.js';

const KEY = '6f1f8f4e-4d4b-4a53-9a0e-2c1f0b7a1c11';
const ORDER_BODY = { items: [{ product_id: 'p_1', qty: 2 }] };

let failed = 0;
function check(label, ok, actual) {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${actual === undefined ? '' : ` → ${actual}`}`);
  if (!ok) failed++;
}

async function main() {
  const app = await createApp();
  await app.listen(0);
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;

  const call = async (method, path, { body, key } = {}) => {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (key !== undefined) headers['Idempotency-Key'] = key;
    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { res, json: await res.json() };
  };

  console.log('\nAcceptance criteria — option B');

  const noKey = await call('POST', '/orders', { body: ORDER_BODY });
  check('POST /orders without Idempotency-Key → 400', noKey.res.status === 400, noKey.res.status);
  check(
    '  … Content-Type: application/problem+json',
    (noKey.res.headers.get('content-type') || '').startsWith('application/problem+json'),
    noKey.res.headers.get('content-type'),
  );
  check('  … detail from the validator', noKey.json.detail === "request/headers must have required property 'idempotency-key'", noKey.json.detail);

  const emptyItems = await call('POST', '/orders', { body: { items: [] }, key: KEY });
  check('POST /orders with empty items → 400', emptyItems.res.status === 400, emptyItems.res.status);
  check('  … detail from the validator', emptyItems.json.detail === 'request/body/items must NOT have fewer than 1 items', emptyItems.json.detail);

  const created = await call('POST', '/orders', { body: ORDER_BODY, key: KEY });
  check('POST /orders valid → 201', created.res.status === 201, created.res.status);
  check('  … total_cents is an integer number of cents', Number.isInteger(created.json.total_cents), created.json.total_cents);

  console.log('\nExtra challenge — full Idempotency-Key semantics');

  const replay = await call('POST', '/orders', { body: ORDER_BODY, key: KEY });
  check('same key + same body → 201', replay.res.status === 201, replay.res.status);
  check('  … Idempotency-Replay: true', replay.res.headers.get('idempotency-replay') === 'true', replay.res.headers.get('idempotency-replay'));
  check('  … same response, no new resource', replay.json.id === created.json.id, replay.json.id);

  const conflict = await call('POST', '/orders', { body: { items: [{ product_id: 'p_2', qty: 9 }] }, key: KEY });
  check('same key + different body → 422', conflict.res.status === 422, conflict.res.status);
  check(
    '  … problem+json',
    (conflict.res.headers.get('content-type') || '').startsWith('application/problem+json'),
    conflict.res.headers.get('content-type'),
  );

  console.log('\nCursor pagination');

  const page1 = await call('GET', '/products?limit=3');
  check('first page: 3 items + an opaque next_cursor', page1.json.items.length === 3 && typeof page1.json.next_cursor === 'string', page1.json.next_cursor);
  const page2 = await call('GET', `/products?limit=3&cursor=${encodeURIComponent(page1.json.next_cursor)}`);
  check('second page does not overlap the first', page2.json.items[0].id !== page1.json.items[0].id, page2.json.items.map((i) => i.id).join(','));
  const lastPage = await call('GET', '/products?limit=100');
  check('last page: next_cursor === null', lastPage.json.next_cursor === null, String(lastPage.json.next_cursor));
  const badLimit = await call('GET', '/products?limit=999');
  check('limit outside the spec range → 400', badLimit.res.status === 400, badLimit.json.detail);

  console.log('\nproblem+json on 404');

  const missing = await call('GET', '/orders/o_999');
  check('GET /orders/o_999 → 404 problem+json', missing.res.status === 404 && missing.json.status === 404, missing.json.detail);
  check('  … all Problem fields present', ['type', 'title', 'status', 'detail', 'instance'].every((f) => f in missing.json));

  await app.close();
  console.log(failed === 0 ? '\n✅ All application checks passed\n' : `\n❌ Checks failed: ${failed}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
