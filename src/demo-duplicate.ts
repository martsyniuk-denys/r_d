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

// The duplicate a crash produces. Consumer A applies the effect and is killed
// with SIGKILL before it can ack — the window between "effect committed" and "ack
// sent", which is where every real duplicate comes from. The broker sees the
// connection die and hands the same message to consumer B, flagged redelivered.
// B applies the same effect, which the natural key turns into a no-op, and acks.

runDemo(async () => {
  const context = await openDemo('demo-duplicate');
  const invariants = new Invariants();

  try {
    const first = await ConsumerProcess.start('--hold-ack-after-effect');
    console.log(`consumer A pid ${first.pid}: applies the effect, then holds the ack`);

    const result = await checkout(
      context.dataSource,
      { buyerId: context.buyerId, productId: context.productId, qty: 1 },
      context.publisher,
    );
    if (!result.ok) throw new Error(`checkout declined: ${result.reason}`);
    const { eventId } = result.event;
    console.log(`order ${result.orderId} placed → order.placed ${eventId} confirmed`);

    await first.waitFor(
      (events) => events.some((e) => e.kind === 'holding' && e.eventId === eventId),
      15_000,
      'consumer A to apply the effect',
    );
    const afterFirst = await fulfilmentsFor(context.dataSource, [result.orderId]);
    const unackedWhileAlive = await settledDepth(context.channel, FULFILMENT_QUEUE, 0);
    const signal = await first.crash();
    console.log(
      `consumer A: effect in the database (${afterFirst} row), ack not sent — killed with ${String(signal)}`,
    );

    const second = await ConsumerProcess.start();
    console.log(`consumer B pid ${second.pid}: normal consumer`);
    await second.waitFor(
      (events) => events.some((e) => e.kind === 'settled' && e.eventId === eventId),
      15_000,
      'consumer B to settle the redelivery',
    );
    const redelivery = second.events.find((e) => e.kind === 'delivery' && e.eventId === eventId);
    const redelivered = redelivery?.kind === 'delivery' && redelivery.redelivered;
    const deliveryCount = redelivery?.kind === 'delivery' ? redelivery.deliveryCount : 0;
    await second.stop();

    const both = [...first.events, ...second.events];
    const deliveries = both.filter((e) => e.kind === 'delivery' && e.eventId === eventId).length;
    const applied = both.filter((e) => e.kind === 'effect' && e.eventId === eventId && e.applied).length;
    const skipped = both.filter((e) => e.kind === 'effect' && e.eventId === eventId && !e.applied).length;
    const effect = await fulfilmentsFor(context.dataSource, [result.orderId]);
    const work = await settledDepth(context.channel, FULFILMENT_QUEUE, 0);
    const dlq = await settledDepth(context.channel, FULFILMENT_DLQ, 0);

    console.log(
      `consumer B: delivery #${deliveryCount}, redelivered=${String(redelivered)}, ` +
        `effect skipped as a duplicate, acked\n`,
    );

    report({
      deliveries,
      effect,
      skipped,
      redelivered: redelivered ? 1 : 0,
      work,
      dlq,
    });

    console.log('\ninvariants');
    invariants.check('consumer A died by SIGKILL, not a clean close', signal === 'SIGKILL', String(signal));
    invariants.check('the unacked message was not in the ready count while A held it', unackedWhileAlive === 0, `${unackedWhileAlive}`);
    invariants.check('the same event was delivered at least twice', deliveries >= 2, `${deliveries}`);
    invariants.check('the second delivery carried the redelivered flag', redelivered, String(redelivered));
    invariants.check('the effect was applied once, in the database', effect === 1, `${effect}`);
    invariants.check('the consumers agree: one applied', applied === 1, `${applied}`);
    invariants.check('the rest were recognised as duplicates', skipped === deliveries - 1, `${skipped} === ${deliveries - 1}`);
    invariants.check('the redelivery was acked, queue empty', work === 0, `${work}`);
    invariants.check('nothing dead-lettered', dlq === 0, `${dlq}`);
  } finally {
    await closeDemo(context);
  }

  return invariants.broken === 0 ? 0 : 1;
});
