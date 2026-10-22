import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { checkoutApp, listen } from './orders/checkout.http';
import {
  ConsumerProcess,
  Invariants,
  RelayProcess,
  closeDemo,
  openDemo,
  pause,
  report,
  runDemo,
} from './messaging/demo-kit';
import { effectOf, ordersOf, outboxOf, processedOf, publishedOf } from './outbox/demo-counts';

// Happy path through the whole chain, and the API-edge key on top of it.
//
// Two POST /checkout with the same Idempotency-Key, sent at the same time: one
// claims the key and commits order + outbox row in one transaction, the other
// waits on the key's unique index and replays the first one's order. The relay
// (a separate process) publishes the outbox row; the consumer (another one)
// applies the effect and marks the message in its inbox.

const QUIET_MS = 1000;

interface Reply {
  status: number;
  orderId: string;
  replayed: boolean;
}

runDemo(async () => {
  const context = await openDemo('demo-outbox', 'outbox-demo@marketplace.test');
  const invariants = new Invariants();
  const consumer = await ConsumerProcess.start();
  const relay = await RelayProcess.start();
  const { server, url } = await listen(checkoutApp(context.dataSource));

  try {
    console.log(`consumer pid ${consumer.pid}, relay pid ${relay.pid}, api ${url}\n`);

    const key = randomUUID();
    const send = async (): Promise<Reply> => {
      const response = await fetch(`${url}/checkout`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': key,
          'x-user-id': context.buyerId,
        },
        body: JSON.stringify({ productId: context.productId, qty: 1 }),
      });
      const body = (await response.json()) as { orderId?: string; detail?: string };
      if (body.orderId === undefined) throw new Error(`POST /checkout ${response.status}: ${body.detail}`);
      return {
        status: response.status,
        orderId: body.orderId,
        replayed: response.headers.get('idempotency-replay') === 'true',
      };
    };

    const replies = await Promise.all([send(), send()]);
    for (const reply of replies) {
      console.log(
        `  POST /checkout  Idempotency-Key: ${key.slice(0, 8)}…  → ${reply.status} order ${reply.orderId}` +
          (reply.replayed ? '  (Idempotency-Replay: true)' : ''),
      );
    }
    const orderId = replies[0].orderId;

    const [{ id: eventId }]: { id: string }[] = await context.dataSource.query(
      `SELECT id FROM outbox WHERE aggregate_type = 'order' AND aggregate_id = $1`,
      [orderId],
    );
    console.log(`  outbox row ${eventId} committed with order ${orderId}`);

    await relay.waitFor(
      (events) => events.some((e) => e.kind === 'marked' && e.eventIds.includes(eventId)),
      15_000,
      'the relay to publish and mark the event',
    );
    await consumer.waitFor(
      (events) => events.some((e) => e.kind === 'settled' && e.eventId === eventId),
      15_000,
      'the consumer to settle the event',
    );
    // Long enough for a second delivery to show up, if there were going to be one.
    await pause(QUIET_MS);
    console.log('  relay: published + marked; consumer: effect applied, inbox marked, acked\n');

    await relay.stop();
    await consumer.stop();

    const ofEvent = <T extends { kind: string; eventId?: string | null }>(e: T): boolean => e.eventId === eventId;
    const requests = replies.length;
    const orders = await ordersOf(context.dataSource, context.buyerId);
    const outbox = await outboxOf(context.dataSource, context.buyerId);
    const published = await publishedOf(context.dataSource, context.buyerId);
    const relayed = relay.count((e) => e.kind === 'published' && ofEvent(e));
    const deliveries = consumer.count((e) => e.kind === 'delivery' && ofEvent(e));
    const applied = consumer.count((e) => e.kind === 'effect' && ofEvent(e) && e.applied);
    const effect = await effectOf(context.dataSource, eventId);
    const processed = await processedOf(context.dataSource, eventId);
    const created = replies.filter((r) => r.status === 201).length;
    const replayed = replies.filter((r) => r.status === 200 && r.replayed).length;

    report({ requests, created, replayed, orders, outbox, published, relayed, deliveries, applied, effect, processed });

    console.log('\ninvariants');
    invariants.check('two requests were sent with one key', requests === 2, `${requests}`);
    invariants.check('both answers name the same order', replies.every((r) => r.orderId === orderId), replies.map((r) => r.orderId).join(', '));
    invariants.check('one created it (201), the other replayed it (200)', created === 1 && replayed === 1, `${created} + ${replayed}`);
    invariants.check('one order in the database', orders === 1, `${orders}`);
    invariants.check('one outbox row, committed with it', outbox === 1, `${outbox}`);
    invariants.check('the row is marked published', published === 1, `${published}`);
    invariants.check('the relay published it once', relayed === 1, `${relayed}`);
    invariants.check('the consumer got it once', deliveries === 1, `${deliveries}`);
    invariants.check('the effect is in the database once', effect === 1 && applied === 1, `${effect} / ${applied}`);
    invariants.check('the inbox holds one mark for it', processed === 1, `${processed}`);
  } finally {
    server.close();
    await closeDemo(context);
  }

  return invariants.broken === 0 ? 0 : 1;
});
