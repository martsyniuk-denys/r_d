import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import {
  ConsumerProcess,
  Invariants,
  RelayProcess,
  closeDemo,
  countOf,
  openDemo,
  pause,
  report,
  runDemo,
} from './messaging/demo-kit';
import { placeOrderOnce } from './orders/place-order-once';
import { effectOf, processedOf } from './outbox/demo-counts';

// The service write fails: the relay dies between publish and UPDATE published_at.
//
// The order and its outbox row commit normally. Relay A runs with
// --hold-after-publish=<eventId>: it locks the row, publishes it, gets the
// broker's confirm — and stops right before the UPDATE. The consumer meanwhile
// receives the event and applies the effect. The demo then kills relay A with
// SIGKILL: Postgres sees the connection die, rolls the relay's transaction back,
// and the row is unpublished and unlocked again. Relay B picks it up and publishes
// it a second time. The consumer gets the same eventId twice; the inbox mark,
// committed with the effect on the first delivery, turns the second into a no-op.
// At-least-once delivery, exactly-once effect.

const QUIET_MS = 1000;

runDemo(async () => {
  const context = await openDemo('demo-crash-relay', 'crash-relay-demo@marketplace.test');
  const invariants = new Invariants();
  const consumer = await ConsumerProcess.start();

  try {
    const placed = await placeOrderOnce(context.dataSource, {
      idempotencyKey: randomUUID(),
      command: { buyerId: context.buyerId, productId: context.productId, qty: 1 },
    });
    if (placed.kind !== 'created') throw new Error(`checkout did not create an order: ${placed.kind}`);
    const { orderId, eventId } = placed;
    console.log(`order ${orderId} + outbox ${eventId} committed`);

    const relayA = await RelayProcess.start(`--hold-after-publish=${eventId}`);
    console.log(`relay A pid ${relayA.pid}: publishes, then holds before UPDATE published_at`);
    await relayA.waitFor(
      (events) => events.some((e) => e.kind === 'holding' && e.eventIds.includes(eventId)),
      15_000,
      'relay A to publish the event and stop before marking it',
    );
    await consumer.waitFor(
      (events) => events.some((e) => e.kind === 'settled' && e.eventId === eventId),
      15_000,
      'the consumer to handle the first delivery',
    );
    const unmarkedWhileHeld = await countOf(
      context.dataSource,
      `SELECT count(*) FROM outbox WHERE id = $1 AND published_at IS NULL`,
      [eventId],
    );
    const effectAfterFirst = await effectOf(context.dataSource, eventId);
    const signal = await relayA.crash();
    console.log(
      `relay A: confirmed by the broker, consumer applied it (${effectAfterFirst} row), ` +
        `published_at still NULL — killed with ${String(signal)}`,
    );

    const relayB = await RelayProcess.start();
    console.log(`relay B pid ${relayB.pid}: normal relay`);
    await relayB.waitFor(
      (events) => events.some((e) => e.kind === 'marked' && e.eventIds.includes(eventId)),
      30_000,
      'relay B to publish and mark the event',
    );
    await consumer.waitFor(
      (events) => events.filter((e) => e.kind === 'settled' && e.eventId === eventId).length >= 2,
      15_000,
      'the consumer to handle the second delivery',
    );
    await pause(QUIET_MS);
    await relayB.stop();
    await consumer.stop();
    console.log('relay B: published it again and marked it; consumer: duplicate, skipped, acked\n');

    const ofEvent = (e: { eventId?: string | null }): boolean => e.eventId === eventId;
    const published = [...relayA.events, ...relayB.events].filter(
      (e) => e.kind === 'published' && ofEvent(e),
    ).length;
    const deliveries = consumer.count((e) => e.kind === 'delivery' && ofEvent(e));
    const applied = consumer.count((e) => e.kind === 'effect' && ofEvent(e) && e.applied);
    const skipped = consumer.count((e) => e.kind === 'effect' && ofEvent(e) && !e.applied);
    const acked = consumer.count((e) => e.kind === 'settled' && ofEvent(e) && e.action === 'ack');
    const effect = await effectOf(context.dataSource, eventId);
    const processed = await processedOf(context.dataSource, eventId);
    const marked = await countOf(
      context.dataSource,
      `SELECT count(*) FROM outbox WHERE id = $1 AND published_at IS NOT NULL`,
      [eventId],
    );

    report({ published, deliveries, applied, skipped, acked, effect, processed, marked });

    console.log('\ninvariants');
    invariants.check('relay A died by SIGKILL, between publish and UPDATE', signal === 'SIGKILL', String(signal));
    invariants.check('the row was still unmarked while A held it', unmarkedWhileHeld === 1, `${unmarkedWhileHeld}`);
    invariants.check('the effect was already applied before the crash', effectAfterFirst === 1, `${effectAfterFirst}`);
    invariants.check('the event was published twice', published >= 2, `${published}`);
    invariants.check('the consumer received it at least twice', deliveries >= 2, `${deliveries}`);
    invariants.check('applied exactly once', applied === 1, `${applied}`);
    invariants.check('every other delivery recognised as a duplicate', skipped === deliveries - 1, `${skipped} === ${deliveries - 1}`);
    invariants.check('every delivery acked', acked === deliveries, `${acked} === ${deliveries}`);
    invariants.check('one effect row in the database', effect === 1, `${effect}`);
    invariants.check('one inbox mark', processed === 1, `${processed}`);
    invariants.check('the row is finally marked published', marked === 1, `${marked}`);
  } finally {
    await closeDemo(context);
  }

  return invariants.broken === 0 ? 0 : 1;
});
