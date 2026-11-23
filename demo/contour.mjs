// The coursework's main contour, end to end, through the public API only:
//
//   1  POST /orders                 → 201 pending   (validation, auth, checkout, outbox)
//   2  the same Idempotency-Key     → the same order, Idempotency-Replay: true
//   3  another buyer reads it       → 403;  no token → 401;  bad body → 400
//   4  relay → RabbitMQ → consumer  → confirmed     (the background part)
//   5  POST /payments/webhook       → paid          (signed by the provider)
//   6  PATCH …/status as admin      → shipped
//   7  GET /orders/{id} + /history  → the final status and every step, read separately
//
//   BASE_URL=http://localhost:3000 npm run demo:contour
//
// Exit 0 only if every step held.
import { randomUUID } from 'node:crypto';

import {
  ADMIN,
  BASE_URL,
  BUYER,
  Invariants,
  OTHER_BUYER,
  call,
  login,
  placeOrder,
  productsInStock,
  report,
  run,
  waitForStatus,
  webhook,
  webhookSecret,
} from './lib/api-client.mjs';

run(async () => {
  const secret = webhookSecret();
  const invariants = new Invariants();
  console.log(`contour against ${BASE_URL}\n`);

  const buyer = await login(BUYER);
  const other = await login(OTHER_BUYER);
  const admin = await login(ADMIN);
  const [first, second] = await productsInStock(2);
  const items = [
    { product_id: first, qty: 1 },
    { product_id: second, qty: 2 },
  ];

  const key = randomUUID();
  const created = await placeOrder(buyer, items, key);
  const order = created.body;
  invariants.check('create', created.status === 201 && order?.status === 'pending', `HTTP ${created.status}, ${order?.id} ${order?.status}, total ${order?.total_cents}`);

  const replay = await placeOrder(buyer, items, key);
  invariants.check(
    'idempotent replay',
    replay.status === 201 && replay.body?.id === order.id && replay.headers.get('idempotency-replay') === 'true',
    `same key → ${replay.body?.id}, Idempotency-Replay: ${replay.headers.get('idempotency-replay')}`,
  );

  const foreign = await call('GET', `/orders/${order.id}`, { token: other });
  const anonymous = await call('GET', `/orders/${order.id}`);
  const invalid = await call('POST', '/orders', {
    token: buyer,
    body: { items: [{ product_id: first, qty: 0 }] },
    headers: { 'idempotency-key': randomUUID() },
  });
  invariants.check(
    'access and validation',
    foreign.status === 403 && anonymous.status === 401 && invalid.status === 400,
    `other buyer ${foreign.status}, no token ${anonymous.status}, qty 0 → ${invalid.status} ${invalid.headers.get('content-type')}`,
  );

  const confirmed = await waitForStatus(buyer, order.id, 'confirmed');
  invariants.check('background: consumer confirmed it', confirmed === 'confirmed', `status ${confirmed}`);

  const paid = await webhook(secret, {
    event_id: `evt_${randomUUID()}`,
    order_id: order.id,
    amount_cents: order.total_cents,
    currency: order.currency,
    outcome: 'succeeded',
  });
  invariants.check('payment webhook', paid.status === 200 && paid.body?.order_status === 'paid', `HTTP ${paid.status}, verdict ${paid.body?.verdict}`);

  const shipped = await call('PATCH', `/orders/${order.id}/status`, { token: admin, body: { status: 'shipped' } });
  const buyerShips = await call('PATCH', `/orders/${order.id}/status`, { token: buyer, body: { status: 'refunded' } });
  invariants.check(
    'operator ships',
    shipped.status === 200 && buyerShips.status === 403,
    `admin → ${shipped.status} ${shipped.body?.status}; buyer → ${buyerShips.status}`,
  );

  const final = await call('GET', `/orders/${order.id}`, { token: buyer });
  const history = await call('GET', `/orders/${order.id}/history`, { token: buyer });
  const steps = (history.body?.items ?? []).map((entry) => `${entry.status}(${entry.changed_by})`);
  invariants.check('final read', final.body?.status === 'shipped', `GET /orders/${order.id} → ${final.body?.status}`);
  invariants.check('history', steps.length === 4, steps.join(' → '));

  console.log('');
  report({
    order: order.id,
    created: created.status === 201 ? 1 : 0,
    replayed: replay.body?.id === order.id ? 1 : 0,
    confirmed: confirmed === 'confirmed' ? 1 : 0,
    paid: paid.body?.order_status === 'paid' ? 1 : 0,
    final: final.body?.status ?? 'unknown',
    history: steps.length,
  });
  return invariants.failures.length === 0 ? 0 : 1;
});
