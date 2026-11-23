import { OrderStatus } from '../entities/order.entity';
import { ORDER_AGGREGATE, ORDER_STATUS_CHANGED, OrderStatusChangedEvent, orderStatusChangedEventId } from '../messaging/events';
import { appendToOutboxIn } from '../outbox/outbox';
import { Queryable } from '../repositories/queryable';

// The order's life, as one table. Anything not listed is refused — by the SQL,
// not only by this map: the UPDATE below matches the current status, so two
// concurrent transitions out of the same status cannot both win.
//
//   pending ──consumer──► confirmed ──webhook──► paid ──admin──► shipped
//      │  └──────────────webhook─────────────────►┘│                │
//      └──────► cancelled ◄──┘                    └──► refunded ◄──┘
export const TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  // pending → paid: the provider may answer before the consumer has confirmed.
  pending: ['confirmed', 'paid', 'cancelled'],
  confirmed: ['paid', 'cancelled'],
  paid: ['shipped', 'refunded'],
  shipped: ['refunded'],
  cancelled: [],
  refunded: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

// The statuses an order may be in for `to` to be reachable from it.
export function sourcesOf(to: OrderStatus): OrderStatus[] {
  return (Object.keys(TRANSITIONS) as OrderStatus[]).filter((from) => canTransition(from, to));
}

export interface StatusChange {
  orderId: string;
  buyerId: string;
  status: OrderStatus;
  previousStatus: OrderStatus;
  historyId: string;
  changedAt: Date;
}

export type TransitionResult =
  | { kind: 'changed'; change: StatusChange }
  | { kind: 'not-found' }
  | { kind: 'refused'; current: OrderStatus };

interface ChangedRow {
  buyer_id: string;
  previous: OrderStatus;
}

// One transition, inside the caller's transaction: the row, its history entry and
// the outbox event commit together or not at all. `db` must already be between
// BEGIN and COMMIT.
export async function transition(
  db: Queryable,
  input: { orderId: string; to: OrderStatus; changedBy: string; from?: readonly OrderStatus[] },
): Promise<TransitionResult> {
  const { orderId, to, changedBy } = input;
  const from = input.from ?? sourcesOf(to);

  // The old status comes from the row locked by the sub-select, so RETURNING can
  // name it: an UPDATE's RETURNING only sees the new values.
  const { rows } = await db.query<ChangedRow>(
    `UPDATE orders o
        SET status = $2
       FROM (SELECT id, status FROM orders WHERE id = $1 FOR UPDATE) old
      WHERE o.id = old.id
        AND old.status = ANY($3::text[])
      RETURNING o.buyer_id, old.status AS previous`,
    [orderId, to, from],
  );

  if (rows.length === 0) {
    const current = await db.query<{ status: OrderStatus }>(`SELECT status FROM orders WHERE id = $1`, [orderId]);
    return current.rows.length === 0 ? { kind: 'not-found' } : { kind: 'refused', current: current.rows[0].status };
  }

  const { buyer_id: buyerId, previous } = rows[0];
  const history = await recordStatus(db, { orderId, status: to, previousStatus: previous, changedBy });

  const event: OrderStatusChangedEvent = {
    eventId: orderStatusChangedEventId(orderId, to),
    type: ORDER_STATUS_CHANGED,
    version: 1,
    occurredAt: history.changedAt.toISOString(),
    data: {
      orderId,
      buyerId,
      status: to,
      previousStatus: previous,
      historyId: history.id,
      changedBy,
    },
  };
  await appendToOutboxIn(db, { type: ORDER_AGGREGATE, id: orderId }, event);

  return {
    kind: 'changed',
    change: { orderId, buyerId, status: to, previousStatus: previous, historyId: history.id, changedAt: history.changedAt },
  };
}

// The first entry of an order's history is written by the checkout itself, with no
// previous status and no outbox event of its own: order.placed already says it.
export async function recordStatus(
  db: Queryable,
  input: { orderId: string; status: OrderStatus; previousStatus: OrderStatus | null; changedBy: string },
): Promise<{ id: string; changedAt: Date }> {
  const { rows } = await db.query<{ id: string; changed_at: Date }>(
    `INSERT INTO order_status_history (order_id, status, previous_status, changed_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, changed_at`,
    [input.orderId, input.status, input.previousStatus, input.changedBy],
  );
  return { id: rows[0].id, changedAt: rows[0].changed_at };
}
