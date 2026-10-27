import { Queryable } from './queryable';
import { Currency } from './products.repository';

// The product card: the product, its seller, what is left in stock, and how it has
// sold — units and orders across every non-cancelled order. The sales part is an
// aggregate over order_items, which grows with every checkout; that is what makes
// this the read worth caching.

export interface ProductCard {
  id: string;
  name: string;
  priceMinor: number;
  currency: Currency;
  stock: number;
  sellerName: string;
  unitsSold: number;
  orders: number;
}

interface Row {
  id: string;
  name: string;
  price_minor: number;
  currency: Currency;
  stock: number;
  seller_name: string;
  units_sold: string;
  orders: string;
}

export class ProductCardsRepository {
  constructor(private readonly db: Queryable) {}

  async findById(id: string): Promise<ProductCard | null> {
    const { rows } = await this.db.query<Row>(
      `SELECT p.id, p.name, p.price_minor, p.currency, p.stock,
              u.display_name AS seller_name,
              COALESCE(s.units_sold, 0) AS units_sold,
              COALESCE(s.orders, 0) AS orders
         FROM products p
         JOIN users u ON u.id = p.seller_id
         LEFT JOIN LATERAL (
              SELECT sum(oi.qty) AS units_sold, count(DISTINCT oi.order_id) AS orders
                FROM order_items oi
                JOIN orders o ON o.id = oi.order_id
               WHERE oi.product_id = p.id
                 AND o.status NOT IN ('cancelled', 'refunded')
         ) s ON true
        WHERE p.id = $1`,
      [id],
    );
    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      id: row.id,
      name: row.name,
      priceMinor: row.price_minor,
      currency: row.currency,
      stock: row.stock,
      sellerName: row.seller_name,
      unitsSold: Number(row.units_sold),
      orders: Number(row.orders),
    };
  }
}
