import { createHash } from 'node:crypto';

import { DataSource } from 'typeorm';

import { CheckoutCommand, CheckoutRejected, CheckoutRejection, PlaceOrderHooks, placeOrder } from '../concurrency/checkout';

export interface PlaceOrderOnceInput {
  idempotencyKey: string;
  command: CheckoutCommand;
}

export type PlaceOrderOnceResult =
  | { kind: 'created'; orderId: string; eventId: string }
  | { kind: 'replayed'; orderId: string }
  | { kind: 'key-reused'; detail: string }
  | { kind: 'rejected'; reason: CheckoutRejection };

// Not the key: two identical orders with two different keys are two orders. The
// hash only lets the server refuse one key sent with two different bodies.
export function requestHash(command: CheckoutCommand): string {
  const { productId, qty } = command;
  return createHash('sha256').update(JSON.stringify({ productId, qty })).digest('hex');
}

interface KeyRow {
  request_hash: string;
  order_id: string | null;
}

// Idempotency-Key with server-side state. The claim, the order and its outbox row
// are one transaction:
//
//   INSERT INTO idempotency_keys … ON CONFLICT DO NOTHING RETURNING
//     one row  → this request owns the key: place the order, record its id, COMMIT
//     no row   → someone has it. If that someone is still in flight, Postgres made
//                this INSERT wait on the unique index until they committed — so
//                the row read next already carries their order id.
//
// No SELECT before the INSERT, so no window in which two requests both see "new".
// A checkout that is declined, or crashes, rolls the claim back with everything
// else, and the same key can be sent again.
export async function placeOrderOnce(
  dataSource: DataSource,
  input: PlaceOrderOnceInput,
  hooks: PlaceOrderHooks = {},
): Promise<PlaceOrderOnceResult> {
  const { idempotencyKey: key, command } = input;
  const hash = requestHash(command);

  try {
    return await dataSource.transaction(async (manager) => {
      const claimed: unknown[] = await manager.query(
        `INSERT INTO idempotency_keys (buyer_id, key, request_hash)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING
         RETURNING key`,
        [command.buyerId, key, hash],
      );

      if (claimed.length === 0) {
        const [seen]: KeyRow[] = await manager.query(
          `SELECT request_hash, order_id FROM idempotency_keys WHERE buyer_id = $1 AND key = $2`,
          [command.buyerId, key],
        );
        if (seen.request_hash !== hash) {
          return {
            kind: 'key-reused',
            detail: `Idempotency-Key '${key}' was already used with a different request body.`,
          } as const;
        }
        return { kind: 'replayed', orderId: seen.order_id! } as const;
      }

      const accepted = await placeOrder(manager, command, hooks);
      await manager.query(
        `UPDATE idempotency_keys SET order_id = $3 WHERE buyer_id = $1 AND key = $2`,
        [command.buyerId, key, accepted.orderId],
      );
      return { kind: 'created', orderId: accepted.orderId, eventId: accepted.event.eventId } as const;
    });
  } catch (error) {
    if (error instanceof CheckoutRejected) return { kind: 'rejected', reason: error.reason };
    throw error;
  }
}
