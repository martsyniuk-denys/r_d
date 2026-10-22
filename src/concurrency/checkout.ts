import { DataSource, EntityManager } from 'typeorm';

import { Currency } from '../entities';
import { ORDER_AGGREGATE, OrderPlacedEvent, toOrderPlacedEvent } from '../messaging/events';
import { appendToOutbox } from '../outbox/outbox';
import { OrdersRepository, fromEntityManager } from '../repositories';
import { returning } from './sql';

export type CheckoutRejection = 'out_of_stock' | 'insufficient_funds';

export class CheckoutRejected extends Error {
  constructor(readonly reason: CheckoutRejection) {
    super(reason);
    this.name = 'CheckoutRejected';
  }
}

export interface CheckoutCommand {
  buyerId: string;
  productId: string;
  qty: number;
}

export interface CheckoutAccepted {
  ok: true;
  orderId: string;
  jobId: string;
  totalMinor: number;
  stockLeft: number;
  event: OrderPlacedEvent;
}

export interface CheckoutDeclined {
  ok: false;
  reason: CheckoutRejection;
}

export type CheckoutResult = CheckoutAccepted | CheckoutDeclined;

interface ReservedRow {
  price_minor: number;
  currency: Currency;
  stock: number;
}

export interface OrderPlacedPublisher {
  publish(event: OrderPlacedEvent): Promise<void>;
}

export interface PlaceOrderHooks {
  // Runs inside the transaction, after the outbox row is written and before
  // COMMIT. demo:crash-write throws from here.
  afterOutbox?: (manager: EntityManager, event: OrderPlacedEvent) => Promise<void>;
}

export async function checkout(
  dataSource: DataSource,
  command: CheckoutCommand,
  events?: OrderPlacedPublisher,
): Promise<CheckoutResult> {
  let accepted: CheckoutAccepted;
  try {
    accepted = await dataSource.transaction((manager) => placeOrder(manager, command));
  } catch (error) {
    if (error instanceof CheckoutRejected) return { ok: false, reason: error.reason };
    throw error;
  }

  // The event that matters is already in the outbox, committed with the order,
  // and the relay will put it on the broker. This direct publish after COMMIT is
  // the homework 19 path, kept for its three demos: it can still be lost (COMMIT
  // done, process gone before the confirm), and a later relay run of the same row
  // is a duplicate the consumer recognises by eventId.
  if (events !== undefined) await events.publish(accepted.event);

  return accepted;
}

export async function placeOrder(
  manager: EntityManager,
  command: CheckoutCommand,
  hooks: PlaceOrderHooks = {},
): Promise<CheckoutAccepted> {
  const { buyerId, productId, qty } = command;

  const reserved = await returning<ReservedRow>(
    manager,
    `UPDATE products
        SET stock = stock - $1
      WHERE id = $2
        AND status = 'active'
        AND stock >= $1
      RETURNING price_minor, currency, stock`,
    [qty, productId],
  );

  if (reserved.length === 0) throw new CheckoutRejected('out_of_stock');

  const { price_minor: priceMinor, currency, stock } = reserved[0];
  const totalMinor = priceMinor * qty;

  const debited = await returning<{ balance_minor: number }>(
    manager,
    `UPDATE users
        SET balance_minor = balance_minor - $1
      WHERE id = $2
        AND balance_minor >= $1
      RETURNING balance_minor`,
    [totalMinor, buyerId],
  );

  if (debited.length === 0) throw new CheckoutRejected('insufficient_funds');

  // The same repository the integration suite exercises, handed the transaction's
  // own connection instead of the pool.
  const orders = new OrdersRepository(fromEntityManager(manager));
  const order = await orders.insert({ buyerId, status: 'pending', currency, totalMinor });
  await orders.addLine({ orderId: order.id, productId, qty, unitPriceMinor: priceMinor });

  const enqueued = await returning<{ id: string }>(
    manager,
    `INSERT INTO jobs (type, payload, order_id)
     VALUES ('order_receipt', $1::jsonb, $2)
     RETURNING id`,
    [JSON.stringify({ orderId: order.id, buyerId, totalMinor }), order.id],
  );

  const event = toOrderPlacedEvent({
    orderId: order.id,
    buyerId,
    totalMinor,
    currency,
    lines: [{ productId, qty, unitPriceMinor: priceMinor }],
  });
  await appendToOutbox(manager, { type: ORDER_AGGREGATE, id: order.id }, event);

  if (hooks.afterOutbox !== undefined) await hooks.afterOutbox(manager, event);

  return {
    ok: true,
    orderId: order.id,
    jobId: enqueued[0].id,
    totalMinor,
    stockLeft: stock,
    event,
  };
}
