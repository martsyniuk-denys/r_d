import { createHash } from 'node:crypto';

import { Currency } from '../entities';

// The exchange is part of the contract a producer needs: where to publish and
// under which routing key. Who is bound to it is not — see topology.ts.
export const EVENTS_EXCHANGE = 'shop.events';

export const ORDER_PLACED = 'order.placed';

// What every event shares, and all a publisher needs to put one on the wire: the
// type doubles as the routing key, the eventId as the AMQP message-id.
export interface DomainEvent {
  eventId: string;
  type: string;
  occurredAt: string;
}

export interface OrderPlacedLine {
  productId: string;
  qty: number;
  unitPriceMinor: number;
}

// A contract, written down on purpose — not an ORM entity spread into JSON. The
// envelope (eventId, type, occurredAt, version) is what every consumer needs to
// route, deduplicate and age an event; `data` is what this particular event is
// about. Spreading an entity would leak column renames into every consumer and
// put the schema's future in the hands of whoever next runs a migration.
export interface OrderPlacedEvent extends DomainEvent {
  eventId: string;
  type: typeof ORDER_PLACED;
  version: 1;
  occurredAt: string;
  data: {
    orderId: string;
    buyerId: string;
    totalMinor: number;
    currency: Currency;
    lines: OrderPlacedLine[];
  };
}

// Derived from the business fact, not drawn at random. A random id would be
// stable across a redelivery of the same message and different for a republish of
// the same fact — and a republish is exactly what a retried operation produces.
// Deriving it means "order 42 was placed" has one identity forever.
export function orderPlacedEventId(orderId: string): string {
  return createHash('sha256').update(`${ORDER_PLACED}:${orderId}`).digest('hex').slice(0, 32);
}

export function orderPlacedEvent(input: {
  orderId: string;
  buyerId: string;
  totalMinor: number;
  currency: Currency;
  lines: OrderPlacedLine[];
  occurredAt?: Date;
}): OrderPlacedEvent {
  return {
    eventId: orderPlacedEventId(input.orderId),
    type: ORDER_PLACED,
    version: 1,
    occurredAt: (input.occurredAt ?? new Date()).toISOString(),
    data: {
      orderId: input.orderId,
      buyerId: input.buyerId,
      totalMinor: input.totalMinor,
      currency: input.currency,
      lines: input.lines,
    },
  };
}

export class UnprocessableEvent extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'UnprocessableEvent';
  }
}

// Anything this function rejects can never succeed by being tried again, which is
// the only honest reason to dead-letter a message rather than requeue it.
export function parseOrderPlaced(raw: Buffer): OrderPlacedEvent {
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new UnprocessableEvent('body is not JSON');
  }

  const event = body as Partial<OrderPlacedEvent>;
  if (typeof event?.eventId !== 'string' || event.eventId === '') {
    throw new UnprocessableEvent('eventId is missing');
  }
  if (event.type !== ORDER_PLACED) {
    throw new UnprocessableEvent(`type is '${String(event.type)}', expected '${ORDER_PLACED}'`);
  }
  if (event.version !== 1) {
    throw new UnprocessableEvent(`version ${String(event.version)} is not supported`);
  }
  const data = event.data;
  if (typeof data?.orderId !== 'string' || !/^\d+$/.test(data.orderId)) {
    throw new UnprocessableEvent('data.orderId is missing or not an identifier');
  }
  if (!Number.isInteger(data.totalMinor)) {
    throw new UnprocessableEvent('data.totalMinor is not an integer');
  }

  return event as OrderPlacedEvent;
}
