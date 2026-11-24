// The edge of the payment webhook, against a live API:
//
//   accepted            a correctly signed event for the frozen amount → paid
//   rejected-signature  the same body signed with another key → 401, no effect
//   amount-mismatch     a correctly signed event for a different amount → 422
//   duplicates          the accepted event delivered again → 200 duplicate, no second effect
//   second-success-ignored
//                       another succeeded event for the same order under a new event id →
//                       200 ignored: the payment is keyed by the order (payment_intents PK
//                       order_id), not by what the sender put in the event
//   payments            'paid' steps in the order's history after all of it, read by a separate request → 1
//
//   npm run demo:webhook      (BASE_URL defaults to http://localhost:3000)
import { randomUUID } from 'node:crypto';

import {
  BASE_URL,
  BUYER,
  Invariants,
  call,
  login,
  placeOrder,
  productsInStock,
  report,
  run,
  webhook,
  webhookSecret,
} from './lib/api-client.mjs';

run(async () => {
  const secret = webhookSecret();
  const invariants = new Invariants();
  console.log(`webhook against ${BASE_URL}\n`);

  const buyer = await login(BUYER);
  const [product] = await productsInStock(1);
  const placed = await placeOrder(buyer, [{ product_id: product, qty: 1 }]);
  if (placed.status !== 201) throw new Error(`checkout failed: HTTP ${placed.status} ${JSON.stringify(placed.body)}`);
  const order = placed.body;

  const event = {
    event_id: `evt_${randomUUID()}`,
    order_id: order.id,
    amount_cents: order.total_cents,
    currency: order.currency,
    outcome: 'succeeded',
  };

  const forged = await webhook(secret, event, { signWith: 'not-the-provider-key-not-the-provider-key' });
  const afterForged = (await call('GET', `/orders/${order.id}`, { token: buyer })).body?.status;
  invariants.check('forged signature', forged.status === 401 && afterForged !== 'paid', `HTTP ${forged.status}, order still ${afterForged}`);

  const mismatch = await webhook(secret, { ...event, event_id: `evt_${randomUUID()}`, amount_cents: order.total_cents - 1 });
  const afterMismatch = (await call('GET', `/orders/${order.id}`, { token: buyer })).body?.status;
  invariants.check(
    'amount mismatch',
    mismatch.status === 422 && afterMismatch !== 'paid',
    `HTTP ${mismatch.status} ${mismatch.body?.type ?? ''}, order still ${afterMismatch}`,
  );

  const accepted = await webhook(secret, event);
  invariants.check('accepted', accepted.status === 200 && accepted.body?.verdict === 'applied', `HTTP ${accepted.status}, ${accepted.body?.verdict} → ${accepted.body?.order_status}`);

  const again = await webhook(secret, event);
  const history = (await call('GET', `/orders/${order.id}/history`, { token: buyer })).body?.items ?? [];
  const paidSteps = history.filter((entry) => entry.status === 'paid').length;
  invariants.check(
    'duplicate',
    again.status === 200 && again.body?.verdict === 'duplicate' && paidSteps === 1,
    `HTTP ${again.status}, verdict ${again.body?.verdict}, 'paid' in history ${paidSteps}×`,
  );

  const second = await webhook(secret, { ...event, event_id: `evt_${randomUUID()}` });
  const finalHistory = (await call('GET', `/orders/${order.id}/history`, { token: buyer })).body?.items ?? [];
  const payments = finalHistory.filter((entry) => entry.status === 'paid').length;
  invariants.check(
    'second success, another event id',
    second.status === 200 && second.body?.verdict === 'ignored' && payments === 1,
    `HTTP ${second.status}, verdict ${second.body?.verdict}, 'paid' in history ${payments}×`,
  );

  console.log('');
  report({
    accepted: accepted.body?.verdict === 'applied' ? 1 : 0,
    'rejected-signature': forged.status === 401 ? 1 : 0,
    'amount-mismatch': mismatch.status === 422 ? 1 : 0,
    duplicates: again.body?.verdict === 'duplicate' ? 1 : 0,
    'second-success-ignored': second.body?.verdict === 'ignored' ? 1 : 0,
    payments,
  });
  return invariants.failures.length === 0 ? 0 : 1;
});
