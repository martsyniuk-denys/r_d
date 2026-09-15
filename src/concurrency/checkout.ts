import { DataSource, EntityManager } from 'typeorm';

import { Currency, Order, OrderItem } from '../entities';
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

export async function checkout(
  dataSource: DataSource,
  command: CheckoutCommand,
): Promise<CheckoutResult> {
  try {
    return await dataSource.transaction((manager) => placeOrder(manager, command));
  } catch (error) {
    if (error instanceof CheckoutRejected) return { ok: false, reason: error.reason };
    throw error;
  }
}

export async function placeOrder(
  manager: EntityManager,
  command: CheckoutCommand,
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

  const orders = manager.getRepository(Order);
  const order = await orders.save(
    orders.create({ buyerId, status: 'pending', currency, totalMinor }),
  );

  const items = manager.getRepository(OrderItem);
  await items.save(
    items.create({ orderId: order.id, productId, qty, unitPriceMinor: priceMinor }),
  );

  const enqueued = await returning<{ id: string }>(
    manager,
    `INSERT INTO jobs (type, payload, order_id)
     VALUES ('order_receipt', $1::jsonb, $2)
     RETURNING id`,
    [JSON.stringify({ orderId: order.id, buyerId, totalMinor }), order.id],
  );

  return { ok: true, orderId: order.id, jobId: enqueued[0].id, totalMinor, stockLeft: stock };
}
