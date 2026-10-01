import { performance } from 'node:perf_hooks';

import { Channel, ConsumeMessage } from 'amqplib';
import { DataSource } from 'typeorm';

import { OrderPlacedEvent, UnprocessableEvent, parseOrderPlaced } from './events';
import { DELIVERY_LIMIT, FULFILMENT_QUEUE, declareTopology } from './topology';

// prefetch × processing time < consumer_timeout (30 min stock). The effect is one
// INSERT, 2–3 ms measured; the worst case is a pool that cannot hand out a
// connection, which fails after DB_CONNECTION_TIMEOUT_MS = 5 s. 32 × 5 s = 160 s,
// an order of magnitude under 1800 s — and 32 in flight is enough to keep a
// 10-connection pool busy across the network round trip, which prefetch = 1 is not.
export const PREFETCH = 32;

export type Settlement = 'ack' | 'dead-letter' | 'requeue';

export type ConsumerEvent =
  | { kind: 'ready'; queue: string; prefetch: number; consumerTag: string }
  | {
      kind: 'delivery';
      eventId: string | null;
      redelivered: boolean;
      deliveryCount: number;
    }
  | { kind: 'effect'; eventId: string; applied: boolean; ms: number }
  | { kind: 'settled'; eventId: string | null; action: Settlement; reason?: string }
  | { kind: 'cancelled' };

export interface ConsumerOptions {
  name: string;
  prefetch?: number;
  observe?: (event: ConsumerEvent) => void;
  // Runs after the effect and before the ack. The demo that proves idempotency
  // uses it to hold the ack back while the process is killed.
  beforeAck?: (event: OrderPlacedEvent) => Promise<void>;
}

export interface RunningConsumer {
  consumerTag: string;
  // basic.cancel, then wait for the deliveries already in hand to settle.
  stop(): Promise<void>;
}

const FOREIGN_KEY_VIOLATION = '23503';

// The effect, expressed through its natural key. Applied twice, it inserts once:
// ON CONFLICT DO NOTHING turns the second attempt into "0 rows", which is how the
// consumer tells an applied event from a duplicate — no lookup first, so no window
// between the check and the write.
export async function applyFulfilment(
  dataSource: DataSource,
  event: OrderPlacedEvent,
  handledBy: string,
): Promise<boolean> {
  const rows: { event_id: string }[] = await dataSource.query(
    `INSERT INTO order_fulfilments (event_id, order_id, line_count, total_minor, handled_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING
     RETURNING event_id`,
    [
      event.eventId,
      event.data.orderId,
      event.data.lines.length,
      event.data.totalMinor,
      handledBy,
    ],
  );
  return rows.length === 1;
}

function eventIdOf(message: ConsumeMessage): string | null {
  const id = message.properties.messageId;
  return typeof id === 'string' && id !== '' ? id : null;
}

function deliveryCountOf(message: ConsumeMessage): number {
  // Quorum queues count earlier deliveries in this header; absent means "first".
  const count = Number(message.properties.headers?.['x-delivery-count'] ?? 0);
  return Number.isFinite(count) ? count + 1 : 1;
}

function isPermanent(error: unknown): boolean {
  if (error instanceof UnprocessableEvent) return true;
  // An event about an order that does not exist will not start existing on retry.
  return (error as { code?: string } | null)?.code === FOREIGN_KEY_VIOLATION;
}

export async function consumeOrderPlaced(
  channel: Channel,
  dataSource: DataSource,
  options: ConsumerOptions,
): Promise<RunningConsumer> {
  const observe = options.observe ?? (() => undefined);
  const prefetch = options.prefetch ?? PREFETCH;
  const inFlight = new Set<Promise<void>>();

  await declareTopology(channel);
  // Per consumer, not per channel (global = false): the default 0 means no limit,
  // and the first consumer to subscribe would take the whole queue.
  await channel.prefetch(prefetch);

  const settle = (
    message: ConsumeMessage,
    eventId: string | null,
    action: Settlement,
    reason?: string,
  ): void => {
    if (action === 'ack') channel.ack(message);
    // requeue = false: the queue's x-dead-letter-exchange takes it, reason "rejected".
    else if (action === 'dead-letter') channel.nack(message, false, false);
    // reject, not nack: on 4.3 only reject counts towards x-delivery-limit, so a
    // message that keeps failing ends up in the DLQ instead of looping for ever.
    // (On the 4.2.9 in compose both count — measured, see the README.)
    else channel.reject(message, true);
    observe({ kind: 'settled', eventId, action, reason });
  };

  const handle = async (message: ConsumeMessage): Promise<void> => {
    const eventIdHint = eventIdOf(message);
    const deliveryCount = deliveryCountOf(message);
    observe({
      kind: 'delivery',
      eventId: eventIdHint,
      redelivered: message.fields.redelivered,
      deliveryCount,
    });

    let event: OrderPlacedEvent;
    try {
      event = parseOrderPlaced(message.content);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      settle(message, eventIdHint, 'dead-letter', reason);
      return;
    }

    try {
      const startedAt = performance.now();
      const applied = await applyFulfilment(dataSource, event, options.name);
      observe({
        kind: 'effect',
        eventId: event.eventId,
        applied,
        ms: Math.round((performance.now() - startedAt) * 100) / 100,
      });

      if (options.beforeAck !== undefined) await options.beforeAck(event);

      // After the effect, never before: an ack is "do not give this to anyone
      // again", and that is only true once the effect is in the database.
      settle(message, event.eventId, 'ack');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (isPermanent(error) || deliveryCount >= DELIVERY_LIMIT) {
        settle(message, event.eventId, 'dead-letter', reason);
      } else {
        settle(message, event.eventId, 'requeue', reason);
      }
    }
  };

  const { consumerTag } = await channel.consume(
    FULFILMENT_QUEUE,
    (message) => {
      // null is not "nothing to do": it is basic.cancel from the broker — the
      // queue was deleted, or consumer_timeout fired. Nothing will arrive on this
      // subscription again, and any ack sent now goes nowhere.
      if (message === null) {
        observe({ kind: 'cancelled' });
        return;
      }
      const work = handle(message).finally(() => inFlight.delete(work));
      inFlight.add(work);
    },
    { noAck: false },
  );

  observe({ kind: 'ready', queue: FULFILMENT_QUEUE, prefetch, consumerTag });

  return {
    consumerTag,
    stop: async () => {
      await channel.cancel(consumerTag);
      await Promise.allSettled([...inFlight]);
    },
  };
}
