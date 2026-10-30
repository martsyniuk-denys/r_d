import 'reflect-metadata';
import { randomUUID } from 'node:crypto';

import { Api, Invariants, login, openDatabase, report, resetAccount, runDemo, tamper } from './auth/demo-kit';

// 401 is "who are you?", 403 is "not you". Two levels of authorization:
//
//   role       POST /products — seller or admin. A buyer's valid token is 403.
//   ownership  GET /orders/{id} — the buyer of that order. Another buyer's valid
//              token is 403; no token at all is 401.
//
// And one forged token: the buyer's own access token with "role": "admin" written
// into the payload and the old signature left on. A server that decodes instead
// of verifying lets it create a product (201); this one answers 401.

const product = (title: string) => ({ title, price_cents: 12_900, currency: 'UAH' });
const key = (): Record<string, string> => ({ 'Idempotency-Key': `demo-rbac-${randomUUID()}` });

runDemo(async () => {
  const invariants = new Invariants();
  const dataSource = await openDatabase();
  let api: Api | undefined;

  try {
    const owner = await resetAccount(dataSource, 'demo-rbac', 'owner', 'buyer');
    const stranger = await resetAccount(dataSource, 'demo-rbac', 'stranger', 'buyer');
    const seller = await resetAccount(dataSource, 'demo-rbac', 'seller', 'seller');
    api = await Api.start();

    const [ownerToken, strangerToken, sellerToken] = (
      await Promise.all([login(api, owner), login(api, stranger), login(api, seller)])
    ).map((reply) => {
      if (reply.status !== 200) throw new Error(`login answered ${reply.status}`);
      return reply.body.access_token;
    });

    const roleAllowed = await api.call<{ id: string }>('POST', '/products', {
      token: sellerToken,
      headers: key(),
      body: product('Auth demo: seller product'),
    });
    const roleDenied = await api.call('POST', '/products', {
      token: ownerToken,
      headers: key(),
      body: product('Auth demo: buyer product'),
    });

    const order = await api.call<{ id: string; buyer_id: string }>('POST', '/orders', {
      token: ownerToken,
      headers: key(),
      body: { items: [{ product_id: roleAllowed.body.id, qty: 1 }] },
    });
    const path = `/orders/${order.body.id}`;

    const anon = await api.call('GET', path);
    const own = await api.call('GET', path, { token: ownerToken });
    const foreign = await api.call('GET', path, { token: strangerToken });

    const forged = tamper(ownerToken, { role: 'admin' });
    const tampered = await api.call('POST', '/products', {
      token: forged,
      headers: key(),
      body: product('Auth demo: forged admin product'),
    });

    const [{ count: forgedRows }]: { count: number }[] = await dataSource.query(
      `SELECT count(*)::int AS count FROM products WHERE name = 'Auth demo: forged admin product'`,
    );

    console.log(`seller ${seller.id} created ${roleAllowed.body.id}; buyer ${owner.id} ordered it as ${order.body.id}`);
    console.log(`${path}: owner ${owner.id} → ${own.status}, stranger ${stranger.id} → ${foreign.status}, no token → ${anon.status}`);
    console.log(`forged token (role=admin, old signature): ${tampered.status}, products written: ${forgedRows}\n`);

    invariants.check('order belongs to its creator', order.status === 201 && order.body.buyer_id === owner.id, `${order.status}, buyer ${order.body.buyer_id}`);
    invariants.check('no token is 401, not 403', anon.status === 401, `${anon.status}`);
    invariants.check('the owner reads the order', own.status === 200, `${own.status}`);
    invariants.check('another buyer is 403, not 404 or 200', foreign.status === 403, `${foreign.status}`);
    invariants.check('a buyer may not write products', roleDenied.status === 403, `${roleDenied.status}`);
    invariants.check('a seller may', roleAllowed.status === 201, `${roleAllowed.status}`);
    invariants.check('a forged payload is 401 and writes nothing', tampered.status === 401 && forgedRows === 0, `${tampered.status}, ${forgedRows} row(s)`);
    console.log('');

    report({
      anon: anon.status,
      own: own.status,
      foreign: foreign.status,
      'role-denied': roleDenied.status,
      'role-allowed': roleAllowed.status,
      tampered: tampered.status,
    });

    if (invariants.broken > 0) console.error(api.log.join('\n'));
    return invariants.broken === 0 ? 0 : 1;
  } finally {
    await api?.stop();
    await dataSource.destroy();
  }
});
