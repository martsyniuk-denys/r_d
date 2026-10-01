import 'reflect-metadata';

import { checkout } from './concurrency/checkout';
import {
  ConsumerProcess,
  Invariants,
  closeDemo,
  fulfilmentsFor,
  openDemo,
  report,
  runDemo,
  settledDepth,
} from './messaging/demo-kit';
import { FULFILMENT_DLQ, FULFILMENT_QUEUE } from './messaging/topology';

// Happy path: five checkouts, each publishing order.placed after its COMMIT,
// consumed by a separate process — five deliveries, five effects, five acks.

const ORDERS = 5;

runDemo(async () => {
  const context = await openDemo('demo-publish');
  const consumer = await ConsumerProcess.start();
  const invariants = new Invariants();

  try {
    console.log(`consumer pid ${consumer.pid}, prefetch ${consumer.prefetch}\n`);

    const orderIds: string[] = [];
    for (let i = 0; i < ORDERS; i += 1) {
      const result = await checkout(
        context.dataSource,
        { buyerId: context.buyerId, productId: context.productId, qty: 1 },
        context.publisher,
      );
      if (!result.ok) throw new Error(`checkout declined: ${result.reason}`);
      orderIds.push(result.orderId);
      console.log(`  order ${result.orderId} placed → order.placed ${result.event.eventId} confirmed`);
    }
    const published = orderIds.length;

    await consumer.waitFor(
      (events) => events.filter((e) => e.kind === 'settled').length >= ORDERS,
      15_000,
      `${ORDERS} settled deliveries`,
    );

    const delivered = consumer.count((e) => e.kind === 'delivery');
    const applied = consumer.count((e) => e.kind === 'effect' && e.applied);
    const acked = consumer.count((e) => e.kind === 'settled' && e.action === 'ack');
    const timings = consumer.events.flatMap((e) => (e.kind === 'effect' ? [e.ms] : []));
    const work = await settledDepth(context.channel, FULFILMENT_QUEUE, 0);
    const dlq = await settledDepth(context.channel, FULFILMENT_DLQ, 0);
    const effect = await fulfilmentsFor(context.dataSource, orderIds);
    const prefetch = consumer.prefetch;

    await consumer.stop();

    console.log('');
    report({
      published,
      delivered,
      effect,
      acked,
      work,
      dlq,
      prefetch,
      'effect-ms-max': Math.max(...timings),
    });

    console.log('\ninvariants');
    invariants.check('every event was published and confirmed', published === ORDERS, `${published} === ${ORDERS}`);
    invariants.check('every event was delivered once', delivered === ORDERS, `${delivered} === ${ORDERS}`);
    invariants.check('one effect per event, in the database', effect === ORDERS, `${effect} === ${ORDERS}`);
    invariants.check('the consumer saw the same effects', applied === effect, `${applied} === ${effect}`);
    invariants.check('every delivery was acked', acked === ORDERS, `${acked} === ${ORDERS}`);
    invariants.check('nothing left in the work queue', work === 0, `${work}`);
    invariants.check('nothing dead-lettered', dlq === 0, `${dlq}`);
    invariants.check('prefetch is set (1..2000)', prefetch >= 1 && prefetch <= 2000, `${prefetch}`);
  } finally {
    await closeDemo(context);
  }

  return invariants.broken === 0 ? 0 : 1;
});
