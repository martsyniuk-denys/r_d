import { createHash } from 'node:crypto';

import { Pool, PoolClient } from 'pg';

import { Currency } from '../entities/product.entity';
import { ORDER_AGGREGATE, toOrderPlacedEvent } from '../messaging/events';
import { appendToOutboxIn } from '../outbox/outbox';
import { OrdersRepository } from '../repositories';
import { recordStatus } from './lifecycle';

// The checkout of the API: several lines, paid later through the provider's
// webhook. One transaction holds all of it —
//
//   idempotency_keys   the claim on (buyer, Idempotency-Key)
//   products           stock reserved per line by an atomic UPDATE … stock >= qty
//   orders + items     status 'pending'
//   payment_intents    the amount the webhook will be checked against, frozen here
//   order_status_history  the first entry
//   outbox             order.placed, for the relay
//
// — so a declined or crashed checkout leaves nothing behind, and the same key can
// be sent again. (src/concurrency/checkout.ts is the one-line, wallet-debiting
// checkout of the concurrency homework; its demos still run on it.)

export interface CheckoutLine {
  productId: string;
  qty: number;
}

export interface PlaceOrderCommand {
  buyerId: string;
  idempotencyKey: string;
  lines: CheckoutLine[];
}

export type PlaceOrderResult =
  | { kind: 'created'; orderId: string }
  | { kind: 'replayed'; orderId: string }
  | { kind: 'key-reused'; detail: string }
  | { kind: 'out-of-stock'; productId: string }
  | { kind: 'unknown-product'; productId: string }
  | { kind: 'mixed-currency' };

class Declined extends Error {
  constructor(readonly result: PlaceOrderResult) {
    super(result.kind);
  }
}

interface ReservedRow {
  id: string;
  price_minor: number;
  currency: Currency;
}

// The same lines in any order are the same request: the hash is over the merged,
// sorted lines, so a client that reorders its cart on retry is not refused with 422.
export function mergeLines(lines: CheckoutLine[]): CheckoutLine[] {
  const merged = new Map<string, number>();
  for (const line of lines) merged.set(line.productId, (merged.get(line.productId) ?? 0) + line.qty);
  return [...merged.entries()]
    .map(([productId, qty]) => ({ productId, qty }))
    .sort((a, b) => (BigInt(a.productId) < BigInt(b.productId) ? -1 : 1));
}

export function requestHash(lines: CheckoutLine[]): string {
  return createHash('sha256').update(JSON.stringify(mergeLines(lines))).digest('hex');
}

export async function placeOrder(pool: Pool, command: PlaceOrderCommand): Promise<PlaceOrderResult> {
  const lines = mergeLines(command.lines);
  const hash = requestHash(lines);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await placeInTransaction(client, command.buyerId, command.idempotencyKey, hash, lines);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    if (error instanceof Declined) return error.result;
    throw error;
  } finally {
    client.release();
  }
}

async function placeInTransaction(
  db: PoolClient,
  buyerId: string,
  key: string,
  hash: string,
  lines: CheckoutLine[],
): Promise<PlaceOrderResult> {
  // No SELECT before the INSERT: a concurrent request with the same key waits on
  // the primary key until this one commits or rolls back.
  const claimed = await db.query(
    `INSERT INTO idempotency_keys (buyer_id, key, request_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING
     RETURNING key`,
    [buyerId, key, hash],
  );

  if (claimed.rowCount === 0) {
    const { rows } = await db.query<{ request_hash: string; order_id: string | null }>(
      `SELECT request_hash, order_id FROM idempotency_keys WHERE buyer_id = $1 AND key = $2`,
      [buyerId, key],
    );
    if (rows[0].request_hash !== hash || rows[0].order_id === null) {
      return { kind: 'key-reused', detail: `Idempotency-Key '${key}' was already used with a different request body.` };
    }
    return { kind: 'replayed', orderId: rows[0].order_id };
  }

  // Lines in product-id order: two carts sharing products lock them in the same
  // order, so they queue instead of deadlocking.
  const reserved: (ReservedRow & { qty: number })[] = [];
  for (const line of lines) {
    const { rows } = await db.query<ReservedRow>(
      `UPDATE products
          SET stock = stock - $1
        WHERE id = $2
          AND status = 'active'
          AND stock >= $1
        RETURNING id, price_minor, currency`,
      [line.qty, line.productId],
    );
    if (rows.length === 0) {
      const exists = await db.query(`SELECT 1 FROM products WHERE id = $1 AND status = 'active'`, [line.productId]);
      throw new Declined(
        exists.rowCount === 0
          ? { kind: 'unknown-product', productId: line.productId }
          : { kind: 'out-of-stock', productId: line.productId },
      );
    }
    reserved.push({ ...rows[0], qty: line.qty });
  }

  const currency = reserved[0].currency;
  if (reserved.some((row) => row.currency !== currency)) throw new Declined({ kind: 'mixed-currency' });
  const totalMinor = reserved.reduce((sum, row) => sum + row.price_minor * row.qty, 0);

  const orders = new OrdersRepository(db);
  const order = await orders.insert({ buyerId, status: 'pending', currency, totalMinor });
  for (const row of reserved) {
    await orders.addLine({ orderId: order.id, productId: row.id, qty: row.qty, unitPriceMinor: row.price_minor });
  }

  await db.query(
    `INSERT INTO payment_intents (order_id, amount_minor, currency) VALUES ($1, $2, $3)`,
    [order.id, totalMinor, currency],
  );
  await recordStatus(db, { orderId: order.id, status: 'pending', previousStatus: null, changedBy: 'checkout' });

  const event = toOrderPlacedEvent({
    orderId: order.id,
    buyerId,
    totalMinor,
    currency,
    lines: reserved.map((row) => ({ productId: row.id, qty: row.qty, unitPriceMinor: row.price_minor })),
  });
  await appendToOutboxIn(db, { type: ORDER_AGGREGATE, id: order.id }, event);

  await db.query(`UPDATE idempotency_keys SET order_id = $3 WHERE buyer_id = $1 AND key = $2`, [buyerId, key, order.id]);
  return { kind: 'created', orderId: order.id };
}
