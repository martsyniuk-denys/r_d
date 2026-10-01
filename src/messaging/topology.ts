import { Channel } from 'amqplib';

import { EVENTS_EXCHANGE, ORDER_PLACED } from './events';

// Declared by the consuming side (the consumer on start, the demos as a bootstrap
// step before they purge), never by the producer: a publisher that asserted the
// queues would have to know who listens to it. assert* is idempotent, so every
// declarer can run it on every start — as long as they all declare the same thing.

export const DEAD_LETTER_EXCHANGE = 'shop.dlx';

export const FULFILMENT_QUEUE = 'fulfilment.order-placed';
export const FULFILMENT_DLQ = 'fulfilment.order-placed.dlq';

// After this many deliveries a quorum queue stops handing the message out and
// dead-letters it with reason delivery_limit — the bound on a message that fails
// for a reason nobody classified as permanent.
export const DELIVERY_LIMIT = 5;

export async function declareTopology(channel: Channel): Promise<void> {
  await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });

  // A separate contour: its own exchange and its own queue, no consumer attached.
  // Direct, keyed by the work queue's name, so one DLX can later serve every
  // work queue without their dead letters landing in each other's DLQ.
  await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'direct', { durable: true });
  await channel.assertQueue(FULFILMENT_DLQ, {
    durable: true,
    arguments: { 'x-queue-type': 'quorum' },
  });
  await channel.bindQueue(FULFILMENT_DLQ, DEAD_LETTER_EXCHANGE, FULFILMENT_QUEUE);

  // Queue arguments are immutable: changing any of these on an existing queue is
  // a 406 PRECONDITION_FAILED until the queue is deleted. See the README.
  await channel.assertQueue(FULFILMENT_QUEUE, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE,
      'x-dead-letter-routing-key': FULFILMENT_QUEUE,
      'x-delivery-limit': DELIVERY_LIMIT,
    },
  });
  // Without this binding a publish to order.placed is confirmed by the broker and
  // then dropped: nothing matched, so there was nothing to deliver to.
  await channel.bindQueue(FULFILMENT_QUEUE, EVENTS_EXCHANGE, ORDER_PLACED);
}
