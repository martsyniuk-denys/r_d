import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import {
  ConsumerProcess,
  DEMO_STOCK,
  Invariants,
  RelayProcess,
  closeDemo,
  countOf,
  openDemo,
  report,
  runDemo,
} from './messaging/demo-kit';
import { placeOrderOnce } from './orders/place-order-once';
import { effectOf, ordersOf, outboxOf, publishedOf } from './outbox/demo-counts';

// The business write fails after the outbox row is already written.
//
// placeOrderOnce() runs as usual — key claimed, stock and balance taken, order
// and line inserted, outbox row inserted — and then the transaction is aborted
// from inside, before COMMIT. Inside it the outbox row is there (the demo counts
// it); after it neither the order nor the row exists, and the relay and the
// consumer, both running the whole time, never see the event. One COMMIT, so one
// ROLLBACK takes both: an event cannot outlive the fact it announces.

const RELAY_PASSES_AFTER = 5;

class SimulatedCrash extends Error {
  constructor() {
    super('simulated crash after the outbox insert, before COMMIT');
    this.name = 'SimulatedCrash';
  }
}

runDemo(async () => {
  const context = await openDemo('demo-crash-write', 'crash-write-demo@marketplace.test');
  const invariants = new Invariants();
  const consumer = await ConsumerProcess.start();
  const relay = await RelayProcess.start();

  try {
    console.log(`consumer pid ${consumer.pid}, relay pid ${relay.pid}\n`);

    let eventId = '';
    let orderId = '';
    let outboxInsideTx = 0;
    let ordersInsideTx = 0;
    let writeFailed = 0;

    try {
      await placeOrderOnce(
        context.dataSource,
        {
          idempotencyKey: randomUUID(),
          command: { buyerId: context.buyerId, productId: context.productId, qty: 1 },
        },
        {
          afterOutbox: async (manager, event) => {
            eventId = event.eventId;
            orderId = event.data.orderId;
            const [outbox]: { count: string }[] = await manager.query(
              `SELECT count(*) FROM outbox WHERE id = $1`,
              [eventId],
            );
            const [orders]: { count: string }[] = await manager.query(
              `SELECT count(*) FROM orders WHERE id = $1`,
              [orderId],
            );
            outboxInsideTx = Number(outbox.count);
            ordersInsideTx = Number(orders.count);
            console.log(
              `  inside the transaction: order ${orderId} (${ordersInsideTx} row), ` +
                `outbox ${eventId} (${outboxInsideTx} row) — now failing before COMMIT`,
            );
            throw new SimulatedCrash();
          },
        },
      );
    } catch (error) {
      if (!(error instanceof SimulatedCrash)) throw error;
      writeFailed = 1;
      console.log(`  ${error.message} → ROLLBACK`);
    }

    // The relay polls every 100 ms; a few full passes after the rollback are a
    // few chances to find a row that should not exist.
    const from = relay.ticks();
    await relay.waitFor(
      () => relay.ticks() >= from + RELAY_PASSES_AFTER,
      15_000,
      `${RELAY_PASSES_AFTER} relay passes after the rollback`,
    );
    console.log(`  relay: ${relay.ticks() - from} passes since, nothing of ours picked up\n`);

    await relay.stop();
    await consumer.stop();

    const ofEvent = (e: { eventId?: string | null }): boolean => e.eventId === eventId;
    const orders = await ordersOf(context.dataSource, context.buyerId);
    const outbox = await outboxOf(context.dataSource, context.buyerId);
    const published = await publishedOf(context.dataSource, context.buyerId);
    const relayed = relay.count((e) => e.kind === 'published' && ofEvent(e));
    const deliveries = consumer.count((e) => e.kind === 'delivery' && ofEvent(e));
    const effect = await effectOf(context.dataSource, eventId);
    const keys = await countOf(context.dataSource, `SELECT count(*) FROM idempotency_keys WHERE buyer_id = $1`, [
      context.buyerId,
    ]);
    const [{ stock }]: { stock: number }[] = await context.dataSource.query(
      `SELECT stock FROM products WHERE id = $1`,
      [context.productId],
    );

    report({
      'write-failed': writeFailed,
      'outbox-inside-tx': outboxInsideTx,
      orders,
      outbox,
      published,
      relayed,
      deliveries,
      effect,
      keys,
    });

    console.log('\ninvariants');
    invariants.check('the business write failed', writeFailed === 1, `${writeFailed}`);
    invariants.check('the outbox row existed inside the transaction', outboxInsideTx === 1 && ordersInsideTx === 1, `${outboxInsideTx} / ${ordersInsideTx}`);
    invariants.check('no order after the rollback', orders === 0, `${orders}`);
    invariants.check('no outbox row after the rollback', outbox === 0, `${outbox}`);
    invariants.check('nothing marked published', published === 0, `${published}`);
    invariants.check('the relay never published it', relayed === 0, `${relayed}`);
    invariants.check('the consumer never received it', deliveries === 0, `${deliveries}`);
    invariants.check('no effect', effect === 0, `${effect}`);
    invariants.check('the idempotency key went with it, so a retry is possible', keys === 0, `${keys}`);
    invariants.check('stock was given back by the same rollback', stock === DEMO_STOCK, `${stock}`);
  } finally {
    await closeDemo(context);
  }

  return invariants.broken === 0 ? 0 : 1;
});
