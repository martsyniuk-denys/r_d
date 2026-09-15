import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';

import { Page, decodeCursor, encodeCursor } from '../common/cursor';
import { notFound } from '../common/problem';
import { PG_POOL } from '../db/database.module';

export interface Product {
  id: string;
  title: string;
  price_cents: number;
  currency: 'UAH' | 'USD' | 'EUR';
  created_at: string;
}

export interface CreateProduct {
  title: string;
  price_cents: number;
  currency: 'UAH' | 'USD' | 'EUR';
}

interface ProductRow {
  id: string;
  title: string;
  price_cents: number;
  currency: 'UAH' | 'USD' | 'EUR';
  created_at: Date;
}

const COLUMNS = `'p_' || id AS id, name AS title, price_minor AS price_cents, currency, created_at`;

const toProduct = (row: ProductRow): Product => ({
  id: row.id,
  title: row.title,
  price_cents: row.price_cents,
  currency: row.currency,
  created_at: row.created_at.toISOString(),
});

const toInternalId = (publicId: string): string | null => {
  const match = /^p_(\d{1,18})$/.exec(publicId);
  return match ? match[1] : null;
};

@Injectable()
export class ProductsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async list(limit: number, cursor?: string): Promise<Page<Product>> {
    const offset = decodeCursor(cursor);
    const { rows } = await this.pool.query<ProductRow>(
      `SELECT ${COLUMNS} FROM products ORDER BY created_at, id LIMIT $1 OFFSET $2`,
      [limit + 1, offset],
    );

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(toProduct);
    return { items, next_cursor: hasMore ? encodeCursor(offset + items.length) : null };
  }

  async get(id: string): Promise<Product> {
    const internalId = toInternalId(id);
    if (internalId === null) throw notFound(`Product '${id}' does not exist.`);

    const { rows } = await this.pool.query<ProductRow>(
      `SELECT ${COLUMNS} FROM products WHERE id = $1`,
      [internalId],
    );
    if (rows.length === 0) throw notFound(`Product '${id}' does not exist.`);
    return toProduct(rows[0]);
  }

  async create(input: CreateProduct): Promise<Product> {
    const { rows } = await this.pool.query<ProductRow>(
      `INSERT INTO products (seller_id, name, price_minor, currency, status)
       VALUES ((SELECT id FROM users ORDER BY id LIMIT 1), $1, $2, $3, 'active')
       RETURNING ${COLUMNS}`,
      [input.title, input.price_cents, input.currency],
    );
    return toProduct(rows[0]);
  }
}
