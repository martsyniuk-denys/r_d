import { Queryable } from './queryable';
import { Currency } from './products.repository';

export type OrderStatus = 'pending' | 'paid' | 'shipped' | 'cancelled' | 'refunded';

export interface OrderRecord {
  id: string;
  buyerId: string;
  status: OrderStatus;
  totalMinor: number;
  currency: Currency;
  createdAt: Date;
}

export interface OrderLine {
  productId: string;
  productName: string;
  qty: number;
  unitPriceMinor: number;
}

export interface OrderWithLines extends OrderRecord {
  lines: OrderLine[];
}

export interface SellerRevenue {
  sellerId: string;
  displayName: string;
  orders: number;
  itemsSold: number;
  revenueMinor: number;
}

interface OrderRow {
  id: string;
  buyer_id: string;
  status: OrderStatus;
  total_minor: number;
  currency: Currency;
  created_at: Date;
}

interface LineRow {
  product_id: string;
  product_name: string;
  qty: number;
  unit_price_minor: number;
}

interface RevenueRow {
  seller_id: string;
  display_name: string;
  orders: string;
  items_sold: string;
  revenue_minor: string;
}

const ORDER_COLUMNS = 'id, buyer_id, status, total_minor, currency, created_at';

const toOrder = (row: OrderRow): OrderRecord => ({
  id: row.id,
  buyerId: row.buyer_id,
  status: row.status,
  totalMinor: row.total_minor,
  currency: row.currency,
  createdAt: row.created_at,
});

export class OrdersRepository {
  constructor(private readonly db: Queryable) {}

  async insert(input: {
    buyerId: string;
    status: OrderStatus;
    totalMinor: number;
    currency: Currency;
  }): Promise<OrderRecord> {
    const { rows } = await this.db.query<OrderRow>(
      `INSERT INTO orders (buyer_id, status, total_minor, currency)
       VALUES ($1, $2, $3, $4)
       RETURNING ${ORDER_COLUMNS}`,
      [input.buyerId, input.status, input.totalMinor, input.currency],
    );
    return toOrder(rows[0]);
  }

  async addLine(input: {
    orderId: string;
    productId: string;
    qty: number;
    unitPriceMinor: number;
  }): Promise<{ id: string }> {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO order_items (order_id, product_id, qty, unit_price_minor)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [input.orderId, input.productId, input.qty, input.unitPriceMinor],
    );
    return rows[0];
  }

  async findById(id: string): Promise<OrderRecord | null> {
    const { rows } = await this.db.query<OrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1`,
      [id],
    );
    return rows.length === 0 ? null : toOrder(rows[0]);
  }

  // The lines come back joined to the catalogue: the product name lives in
  // products, never copied into order_items, so only SQL can answer this.
  async findWithLines(id: string): Promise<OrderWithLines | null> {
    const order = await this.findById(id);
    if (order === null) return null;

    const { rows } = await this.db.query<LineRow>(
      `SELECT oi.product_id, p.name AS product_name, oi.qty, oi.unit_price_minor
         FROM order_items oi
         JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = $1
        ORDER BY oi.id`,
      [id],
    );

    return {
      ...order,
      lines: rows.map((row) => ({
        productId: row.product_id,
        productName: row.product_name,
        qty: row.qty,
        unitPriceMinor: row.unit_price_minor,
      })),
    };
  }

  async countLines(orderId: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM order_items WHERE order_id = $1`,
      [orderId],
    );
    return Number(rows[0].count);
  }

  async delete(id: string): Promise<number> {
    const { rowCount } = await this.db.query(`DELETE FROM orders WHERE id = $1`, [id]);
    return rowCount ?? 0;
  }

  // Revenue per seller: three tables, two aggregates and a GROUP BY. The numbers
  // are text because sum() over bigint is numeric and node-postgres will not
  // silently narrow it.
  async revenueBySeller(statuses: OrderStatus[] = ['paid', 'shipped']): Promise<SellerRevenue[]> {
    const { rows } = await this.db.query<RevenueRow>(
      `SELECT u.id AS seller_id,
              u.display_name,
              count(DISTINCT o.id)::text        AS orders,
              sum(oi.qty)::text                 AS items_sold,
              sum(oi.qty * oi.unit_price_minor)::text AS revenue_minor
         FROM orders o
         JOIN order_items oi ON oi.order_id = o.id
         JOIN products p     ON p.id = oi.product_id
         JOIN users u        ON u.id = p.seller_id
        WHERE o.status = ANY($1)
        GROUP BY u.id, u.display_name
        ORDER BY sum(oi.qty * oi.unit_price_minor) DESC, u.id`,
      [statuses],
    );

    return rows.map((row) => ({
      sellerId: row.seller_id,
      displayName: row.display_name,
      orders: Number(row.orders),
      itemsSold: Number(row.items_sold),
      revenueMinor: Number(row.revenue_minor),
    }));
  }
}
