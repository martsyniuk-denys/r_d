import { DataSource } from 'typeorm';

import { countOf } from '../messaging/demo-kit';
import { FULFILMENT_CONSUMER } from '../messaging/order-placed.consumer';

// What the three outbox demos count, all scoped to the demo's own buyer or event:
// the dev database may hold other orders (demo:race leaves ten, each with a
// pending outbox row the relay will publish alongside), and they are not ours.

export const ordersOf = (ds: DataSource, buyerId: string): Promise<number> =>
  countOf(ds, `SELECT count(*) FROM orders WHERE buyer_id = $1`, [buyerId]);

export const outboxOf = (ds: DataSource, buyerId: string): Promise<number> =>
  countOf(ds, `SELECT count(*) FROM outbox WHERE payload->'data'->>'buyerId' = $1`, [buyerId]);

export const publishedOf = (ds: DataSource, buyerId: string): Promise<number> =>
  countOf(
    ds,
    `SELECT count(*) FROM outbox WHERE payload->'data'->>'buyerId' = $1 AND published_at IS NOT NULL`,
    [buyerId],
  );

export const effectOf = (ds: DataSource, eventId: string): Promise<number> =>
  countOf(ds, `SELECT count(*) FROM order_fulfilments WHERE event_id = $1`, [eventId]);

export const processedOf = (ds: DataSource, eventId: string): Promise<number> =>
  countOf(ds, `SELECT count(*) FROM processed_messages WHERE message_id = $1 AND consumer = $2`, [
    eventId,
    FULFILMENT_CONSUMER,
  ]);
