import { Queryable } from './queryable';

export type Currency = 'UAH' | 'USD' | 'EUR';
export type ProductStatus = 'draft' | 'active' | 'archived';

export interface ProductRecord {
  id: string;
  sellerId: string;
  name: string;
  description: string;
  priceMinor: number;
  currency: Currency;
  status: ProductStatus;
  stock: number;
  createdAt: Date;
}

export interface NewProduct {
  sellerId: string;
  name: string;
  priceMinor: number;
  currency: Currency;
  status?: ProductStatus;
  description?: string;
  stock?: number;
}

interface Row {
  id: string;
  seller_id: string;
  name: string;
  description: string;
  price_minor: number;
  currency: Currency;
  status: ProductStatus;
  stock: number;
  created_at: Date;
}

const COLUMNS = 'id, seller_id, name, description, price_minor, currency, status, stock, created_at';

const toRecord = (row: Row): ProductRecord => ({
  id: row.id,
  sellerId: row.seller_id,
  name: row.name,
  description: row.description,
  priceMinor: row.price_minor,
  currency: row.currency,
  status: row.status,
  stock: row.stock,
  createdAt: row.created_at,
});

export class ProductsRepository {
  constructor(private readonly db: Queryable) {}

  async insert(input: NewProduct): Promise<ProductRecord> {
    const { rows } = await this.db.query<Row>(
      `INSERT INTO products (seller_id, name, description, price_minor, currency, status, stock)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${COLUMNS}`,
      [
        input.sellerId,
        input.name,
        input.description ?? '',
        input.priceMinor,
        input.currency,
        input.status ?? 'active',
        input.stock ?? 0,
      ],
    );
    return toRecord(rows[0]);
  }

  async findById(id: string): Promise<ProductRecord | null> {
    const { rows } = await this.db.query<Row>(
      `SELECT ${COLUMNS} FROM products WHERE id = $1`,
      [id],
    );
    return rows.length === 0 ? null : toRecord(rows[0]);
  }

  async page(limit: number, offset: number): Promise<ProductRecord[]> {
    const { rows } = await this.db.query<Row>(
      `SELECT ${COLUMNS} FROM products ORDER BY created_at, id LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return rows.map(toRecord);
  }

  // Reads the generated tsvector column, so it matches whole words in any order
  // and ignores what a LIKE '%…%' would happily return.
  async search(term: string, limit = 20): Promise<ProductRecord[]> {
    const { rows } = await this.db.query<Row>(
      `SELECT ${COLUMNS}
         FROM products
        WHERE search_vector @@ plainto_tsquery('simple', $1)
        ORDER BY id
        LIMIT $2`,
      [term, limit],
    );
    return rows.map(toRecord);
  }
}
