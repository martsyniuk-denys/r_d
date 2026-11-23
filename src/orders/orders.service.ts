import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';

import { Principal } from '../auth/principal';
import { Page, decodeCursor, encodeCursor } from '../common/cursor';
import { ProblemError, conflict, idempotencyKeyReuse, notFound } from '../common/problem';
import { PG_POOL } from '../db/database.module';
import { OrderStatus } from '../entities/order.entity';
import { layerLogger } from '../observability/logger';
import { inSpan } from '../observability/span';
import { OrderLine, OrderRecord, OrdersRepository, StatusHistoryEntry } from '../repositories';
import { canTransition, transition } from './lifecycle';
import { PlaceOrderResult, placeOrder } from './place-order';

export interface OrderItem {
  product_id: string;
  qty: number;
  unit_price_cents: number;
}

export interface Order {
  id: string;
  status: OrderStatus;
  buyer_id: string | null;
  currency: 'UAH' | 'USD' | 'EUR';
  items: OrderItem[];
  total_cents: number;
  created_at: string;
}

export interface OrderHistoryEntry {
  id: number;
  status: OrderStatus;
  previous_status: OrderStatus | null;
  changed_by: string;
  changed_at: string;
}

export interface CreateOrderLine {
  product_id: string;
  qty: number;
}

export interface Placed {
  order: Order;
  replayed: boolean;
}

const log = layerLogger('orders.service');

// Public ids carry a prefix; the database's are bigints. Anything that is not
// o_<digits> cannot name an order, so it is a 404 without a query.
export const toPublicOrderId = (id: string): string => `o_${id}`;
export const toInternalOrderId = (publicId: string): string | null => /^o_(\d{1,18})$/.exec(publicId)?.[1] ?? null;
const toInternalProductId = (publicId: string): string | null => /^p_(\d{1,18})$/.exec(publicId)?.[1] ?? null;

const toOrder = (record: OrderRecord, lines: OrderLine[]): Order => ({
  id: toPublicOrderId(record.id),
  status: record.status,
  buyer_id: record.buyerId,
  currency: record.currency,
  items: lines.map((line) => ({
    product_id: `p_${line.productId}`,
    qty: line.qty,
    unit_price_cents: line.unitPriceMinor,
  })),
  total_cents: record.totalMinor,
  created_at: record.createdAt.toISOString(),
});

const toHistoryEntry = (entry: StatusHistoryEntry): OrderHistoryEntry => ({
  id: Number(entry.id),
  status: entry.status,
  previous_status: entry.previousStatus,
  changed_by: entry.changedBy,
  changed_at: entry.changedAt.toISOString(),
});

@Injectable()
export class OrdersService {
  private readonly orders: OrdersRepository;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    this.orders = new OrdersRepository(pool);
  }

  // Ownership in the read itself: WHERE buyer_id = $1. An admin reads every order.
  async listFor(principal: Principal, limit: number, cursor?: string): Promise<Page<Order>> {
    const offset = decodeCursor(cursor);
    const buyer = principal.role === 'admin' ? null : principal.userId;
    const records = await this.orders.page(buyer, limit + 1, offset);

    const pageRecords = records.slice(0, limit);
    const lines = await this.orders.linesOf(pageRecords.map((r) => r.id));
    const items = pageRecords.map((r) => toOrder(r, lines.get(r.id) ?? []));
    return { items, next_cursor: records.length > limit ? encodeCursor(offset + items.length) : null };
  }

  async find(publicId: string): Promise<Order | undefined> {
    const id = toInternalOrderId(publicId);
    if (id === null) return undefined;
    const record = await this.orders.findWithLines(id);
    return record === null ? undefined : toOrder(record, record.lines);
  }

  create(key: string, lines: CreateOrderLine[], buyerId: string): Promise<Placed> {
    return inSpan('orders.place', () => this.place(key, lines, buyerId));
  }

  async history(order: Order): Promise<OrderHistoryEntry[]> {
    const entries = await this.orders.history(toInternalOrderId(order.id)!);
    return entries.map(toHistoryEntry);
  }

  // Admin-only at the controller; here, only the transition table decides. The
  // UPDATE matches the status read a moment ago, so a change that raced this one
  // is a 409, not a silent overwrite.
  async setStatus(order: Order, status: OrderStatus, principal: Principal): Promise<Order> {
    if (!canTransition(order.status, status)) {
      throw conflict(`Order '${order.id}' cannot go from '${order.status}' to '${status}'.`);
    }
    const id = toInternalOrderId(order.id)!;
    const client = await this.pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      result = await transition(client, {
        orderId: id,
        to: status,
        from: [order.status],
        changedBy: `admin:${principal.userId}`,
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    if (result.kind !== 'changed') {
      throw conflict(`Order '${order.id}' changed meanwhile; read it again before changing its status.`);
    }
    log.info({ orderId: order.id, from: order.status, to: status }, 'order status changed');
    return (await this.find(order.id))!;
  }

  private async place(key: string, lines: CreateOrderLine[], buyerId: string): Promise<Placed> {
    log.info({ lines: lines.length }, 'placing order');
    const internal = lines.map((line) => {
      const productId = toInternalProductId(line.product_id);
      if (productId === null) throw notFound(`Product '${line.product_id}' does not exist.`);
      return { productId, qty: line.qty };
    });

    const result = await placeOrder(this.pool, { buyerId, idempotencyKey: key, lines: internal });
    if (result.kind !== 'created' && result.kind !== 'replayed') throw declined(result);

    const order = (await this.find(toPublicOrderId(result.orderId)))!;
    log.info({ orderId: order.id, total_cents: order.total_cents, outcome: result.kind }, 'order placed');
    return { order, replayed: result.kind === 'replayed' };
  }
}

function declined(result: Exclude<PlaceOrderResult, { kind: 'created' | 'replayed' }>): ProblemError {
  switch (result.kind) {
    case 'key-reused':
      return idempotencyKeyReuse(result.detail);
    case 'unknown-product':
      return notFound(`Product 'p_${result.productId}' does not exist.`);
    case 'out-of-stock':
      return conflict(`Product 'p_${result.productId}' does not have enough stock for this order.`);
    case 'mixed-currency':
      return conflict('All lines of one order must be priced in the same currency.');
  }
}
