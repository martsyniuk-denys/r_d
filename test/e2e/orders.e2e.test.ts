import { randomUUID } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { OrderPlacedEvent } from '../../src/messaging/events';
import { applyFulfilment } from '../../src/messaging/order-placed.consumer';
import { sign } from '../../src/payments/signature';
import { anAccount, loginAs, TestAccount } from '../testkit/auth';
import { aProduct } from '../testkit/builders';
import { connectionUri, testPool } from '../testkit/database';

// The coursework's main contour against the real module graph and the
// testcontainer: checkout → the consumer's effect → the provider's webhook → the
// final read. The consumer is called in-process with the event the checkout wrote
// to the outbox — the same function the RabbitMQ consumer runs per delivery.
describe('Orders contour end to end', () => {
  let app: INestApplication;
  let pool: Pool;
  let dataSource: DataSource;
  let buyer: TestAccount;
  let other: TestAccount;
  let admin: TestAccount;
  const tokens: Record<string, string> = {};

  const http = () => request(app.getHttpServer());
  const place = (token: string, items: unknown, key: string = randomUUID()) =>
    http().post('/orders').auth(token, { type: 'bearer' }).set('Idempotency-Key', key).send({ items });
  const webhook = (payload: object, secret = process.env.PAYMENT_WEBHOOK_SECRET!) => {
    const raw = JSON.stringify(payload);
    return http()
      .post('/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Signature', sign(raw, secret))
      .send(raw);
  };
  const placedEvent = async (publicId: string): Promise<OrderPlacedEvent> => {
    const { rows } = await pool.query<{ payload: OrderPlacedEvent }>(
      `SELECT payload FROM outbox WHERE aggregate_id = $1 AND type = 'order.placed'`,
      [publicId.slice(2)],
    );
    return rows[0].payload;
  };

  beforeAll(async () => {
    pool = testPool();
    dataSource = await new DataSource({ type: 'postgres', url: connectionUri() }).initialize();
    buyer = await anAccount(pool, 'buyer');
    other = await anAccount(pool, 'buyer');
    admin = await anAccount(pool, 'admin');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = await configureApp(moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false }));

    tokens.buyer = (await loginAs(app, buyer)).access_token;
    tokens.other = (await loginAs(app, other)).access_token;
    tokens.admin = (await loginAs(app, admin)).access_token;
  });

  afterAll(async () => {
    await app?.close();
    await dataSource?.destroy();
    await pool?.end();
  });

  it('runs the whole contour: pending → confirmed → paid, read back separately', async () => {
    const shoes = await aProduct().pricedAt(150_000).create(pool);
    const socks = await aProduct().pricedAt(19_900).create(pool);
    const items = [
      { product_id: `p_${shoes.id}`, qty: 1 },
      { product_id: `p_${socks.id}`, qty: 3 },
    ];
    const key = randomUUID();

    const created = await place(tokens.buyer, items, key).expect(201);
    expect(created.body).toMatchObject({ status: 'pending', buyer_id: buyer.id, total_cents: 150_000 + 3 * 19_900 });

    const replay = await place(tokens.buyer, items, key).expect(201);
    expect(replay.body.id).toBe(created.body.id);
    expect(replay.headers['idempotency-replay']).toBe('true');

    const orderId: string = created.body.id;
    expect(await applyFulfilment(dataSource, await placedEvent(orderId), 'e2e')).toBe(true);
    // A redelivery of the same event is recognised, not applied twice.
    expect(await applyFulfilment(dataSource, await placedEvent(orderId), 'e2e')).toBe(false);

    const confirmed = await http().get(`/orders/${orderId}`).auth(tokens.buyer, { type: 'bearer' }).expect(200);
    expect(confirmed.body.status).toBe('confirmed');

    const paid = await webhook({
      event_id: `evt_${randomUUID()}`,
      order_id: orderId,
      amount_cents: created.body.total_cents,
      currency: 'UAH',
      outcome: 'succeeded',
    }).expect(200);
    expect(paid.body).toMatchObject({ verdict: 'applied', order_status: 'paid' });

    const final = await http().get(`/orders/${orderId}`).auth(tokens.buyer, { type: 'bearer' }).expect(200);
    expect(final.body.status).toBe('paid');

    const history = await http().get(`/orders/${orderId}/history`).auth(tokens.buyer, { type: 'bearer' }).expect(200);
    expect(history.body.items.map((e: { status: string; changed_by: string }) => `${e.status}:${e.changed_by}`)).toEqual([
      'pending:checkout',
      'confirmed:fulfilment',
      'paid:payment-webhook',
    ]);

    const events = await pool.query<{ type: string }>(`SELECT type FROM outbox WHERE aggregate_id = $1 ORDER BY created_at`, [
      orderId.slice(2),
    ]);
    expect(events.rows.map((r) => r.type)).toEqual(['order.placed', 'order.status_changed', 'order.status_changed']);
  });

  it('keeps 400, 401, 403 and 422 apart at the edge', async () => {
    const product = await aProduct().create(pool);
    const items = [{ product_id: `p_${product.id}`, qty: 1 }];

    const noKey = await http().post('/orders').auth(tokens.buyer, { type: 'bearer' }).send({ items }).expect(400);
    expect(noKey.headers['content-type']).toMatch(/application\/problem\+json/);
    await place(tokens.buyer, [{ product_id: `p_${product.id}`, qty: 0 }]).expect(400);
    await http().post('/orders').set('Idempotency-Key', randomUUID()).send({ items }).expect(401);

    const key = randomUUID();
    const created = await place(tokens.buyer, items, key).expect(201);
    await place(tokens.buyer, [{ product_id: `p_${product.id}`, qty: 2 }], key).expect(422);

    await http().get(`/orders/${created.body.id}`).auth(tokens.other, { type: 'bearer' }).expect(403);
    await http().get(`/orders/${created.body.id}/history`).auth(tokens.other, { type: 'bearer' }).expect(403);
    await http().get('/orders/o_999999999').auth(tokens.buyer, { type: 'bearer' }).expect(404);
  });

  it('rolls the whole checkout back when one line is short', async () => {
    const plenty = await aProduct().create(pool);
    const scarce = await aProduct().create(pool);
    await pool.query(`UPDATE products SET stock = 1 WHERE id = $1`, [scarce.id]);

    const declined = await place(tokens.buyer, [
      { product_id: `p_${plenty.id}`, qty: 2 },
      { product_id: `p_${scarce.id}`, qty: 2 },
    ]).expect(409);
    expect(declined.body.type).toMatch(/conflict$/);

    const { rows } = await pool.query<{ id: string; stock: number }>(
      `SELECT id, stock FROM products WHERE id = ANY($1::bigint[]) ORDER BY id`,
      [[plenty.id, scarce.id]],
    );
    expect(rows.map((r) => r.stock)).toEqual([10, 1]);
  });

  it('sells exactly the stock under a parallel burst', async () => {
    const product = await aProduct().create(pool);
    await pool.query(`UPDATE products SET stock = 5 WHERE id = $1`, [product.id]);

    const replies = await Promise.all(
      Array.from({ length: 30 }, () => place(tokens.buyer, [{ product_id: `p_${product.id}`, qty: 1 }])),
    );
    const statuses = replies.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(5);
    expect(statuses.filter((s) => s === 409)).toHaveLength(25);

    const { rows } = await pool.query<{ stock: number }>(`SELECT stock FROM products WHERE id = $1`, [product.id]);
    expect(rows[0].stock).toBe(0);
  });

  it('accepts a webhook only when signed, once, and for the frozen amount', async () => {
    const product = await aProduct().create(pool);
    const created = await place(tokens.buyer, [{ product_id: `p_${product.id}`, qty: 1 }]).expect(201);
    const event = {
      event_id: `evt_${randomUUID()}`,
      order_id: created.body.id,
      amount_cents: created.body.total_cents,
      currency: 'UAH',
      outcome: 'succeeded',
    };

    await webhook(event, 'a-key-that-is-not-the-providers-key-at-all').expect(401);
    const mismatch = await webhook({ ...event, event_id: `evt_${randomUUID()}`, amount_cents: 1 }).expect(422);
    expect(mismatch.body.type).toMatch(/amount-mismatch$/);

    await webhook(event).expect(200);
    const again = await webhook(event).expect(200);
    expect(again.body.verdict).toBe('duplicate');

    const { rows } = await pool.query<{ verdict: string }>(
      `SELECT verdict FROM payment_events WHERE order_id = $1 ORDER BY id`,
      [created.body.id.slice(2)],
    );
    expect(rows.map((r) => r.verdict)).toEqual(['amount_mismatch', 'applied']);
  });

  it('lets only an admin move a status, and only along the lifecycle', async () => {
    const product = await aProduct().create(pool);
    const created = await place(tokens.buyer, [{ product_id: `p_${product.id}`, qty: 1 }]).expect(201);
    const path = `/orders/${created.body.id}/status`;

    await http().patch(path).auth(tokens.buyer, { type: 'bearer' }).send({ status: 'paid' }).expect(403);
    await http().patch(path).auth(tokens.admin, { type: 'bearer' }).send({ status: 'shipped' }).expect(409);
    const cancelled = await http().patch(path).auth(tokens.admin, { type: 'bearer' }).send({ status: 'cancelled' }).expect(200);
    expect(cancelled.body.status).toBe('cancelled');
  });
});
