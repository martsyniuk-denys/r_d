import 'reflect-metadata';

import {
  ConsumerProcess,
  Invariants,
  closeDemo,
  openDemo,
  report,
  runDemo,
  settledDepth,
} from './messaging/demo-kit';
import { ORDER_PLACED } from './messaging/events';
import { FULFILMENT_DLQ, FULFILMENT_QUEUE } from './messaging/topology';

// A poisoned message: what a producer sends when it spreads its ORM entity into
// the body instead of building the contract. No eventId, no type, no version —
// no retry will ever make it parse. The consumer rejects it with requeue = false,
// the work queue's dead-letter exchange routes it into the DLQ, and the demo
// reads back from x-death why it is there.

const DEATH_REASONS = ['rejected', 'expired', 'maxlen', 'delivery_limit'];

interface XDeath {
  reason?: string;
  queue?: string;
  count?: number;
  exchange?: string;
  'routing-keys'?: string[];
}

runDemo(async () => {
  const context = await openDemo('demo-dlq');
  const consumer = await ConsumerProcess.start();
  const invariants = new Invariants();

  try {
    const poisonId = `poison-${Date.now()}`;
    const entitySpread = {
      id: '42',
      buyerId: context.buyerId,
      status: 'pending',
      totalMinor: 1250,
      createdAt: new Date().toISOString(),
    };

    await context.publisher.publishRaw(ORDER_PLACED, Buffer.from(JSON.stringify(entitySpread)), {
      messageId: poisonId,
    });
    console.log(`published ${poisonId}: an entity spread, not an order.placed event`);

    await consumer.waitFor(
      (events) => events.some((e) => e.kind === 'settled' && e.eventId === poisonId),
      15_000,
      'the poisoned delivery to be settled',
    );
    const settled = consumer.events.find((e) => e.kind === 'settled' && e.eventId === poisonId);
    if (settled?.kind === 'settled') {
      console.log(`consumer: ${settled.action} (${settled.reason ?? 'no reason'})`);
    }

    const rejected = consumer.count((e) => e.kind === 'settled' && e.action === 'dead-letter');
    const effect = consumer.count((e) => e.kind === 'effect' && e.applied);
    await consumer.stop();

    // Read the dead letter without consuming it: get, look, put it back. The DLQ
    // has no consumer of its own — it is where a human or a replay tool looks.
    await settledDepth(context.channel, FULFILMENT_DLQ, 1);
    const dead = await context.channel.get(FULFILMENT_DLQ, { noAck: false });
    if (dead === false) throw new Error('the DLQ is empty — nothing was dead-lettered');

    const headers = dead.properties.headers ?? {};
    const deaths = (headers['x-death'] ?? []) as XDeath[];
    const firstReason = String(headers['x-first-death-reason'] ?? deaths[0]?.reason ?? 'unknown');

    console.log(`\nx-death on ${dead.properties.messageId}:`);
    for (const death of deaths) {
      console.log(
        `  reason ${death.reason}, queue ${death.queue}, count ${death.count}, ` +
          `exchange ${death.exchange}, routing-keys ${(death['routing-keys'] ?? []).join(',')}`,
      );
    }
    console.log(`x-first-death-reason: ${String(headers['x-first-death-reason'])}`);
    console.log(`x-first-death-queue:  ${String(headers['x-first-death-queue'])}\n`);

    context.channel.nack(dead, false, true);

    const work = await settledDepth(context.channel, FULFILMENT_QUEUE, 0);
    const dlq = await settledDepth(context.channel, FULFILMENT_DLQ, 1);

    report({ rejected, work, dlq, 'dlq-reason': firstReason, effect });

    console.log('\ninvariants');
    invariants.check('the consumer rejected the poisoned message', rejected === 1, `${rejected}`);
    invariants.check('the work queue is empty', work === 0, `${work}`);
    invariants.check('exactly one message in the DLQ', dlq === 1, `${dlq}`);
    invariants.check(
      'the reason was read from x-death',
      DEATH_REASONS.includes(firstReason) && deaths.length > 0,
      firstReason,
    );
    invariants.check(
      'it died in the work queue',
      deaths[0]?.queue === FULFILMENT_QUEUE,
      String(deaths[0]?.queue),
    );
    invariants.check('no effect was applied', effect === 0, `${effect}`);
  } finally {
    await closeDemo(context);
  }

  return invariants.broken === 0 ? 0 : 1;
});
