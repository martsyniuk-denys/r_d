import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';

import { Page, decodeCursor, encodeCursor } from '../common/cursor';
import { notFound } from '../common/problem';
import { PG_POOL } from '../db/database.module';
import { ProductRecord, ProductsRepository } from '../repositories';

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

const toProduct = (record: ProductRecord): Product => ({
  id: `p_${record.id}`,
  title: record.name,
  price_cents: record.priceMinor,
  currency: record.currency,
  created_at: record.createdAt.toISOString(),
});

const toInternalId = (publicId: string): string | null => {
  const match = /^p_(\d{1,18})$/.exec(publicId);
  return match ? match[1] : null;
};

@Injectable()
export class ProductsService {
  private readonly products: ProductsRepository;

  constructor(@Inject(PG_POOL) pool: Pool) {
    this.products = new ProductsRepository(pool);
  }

  async list(limit: number, cursor?: string): Promise<Page<Product>> {
    const offset = decodeCursor(cursor);
    const records = await this.products.page(limit + 1, offset);

    const hasMore = records.length > limit;
    const items = records.slice(0, limit).map(toProduct);
    return { items, next_cursor: hasMore ? encodeCursor(offset + items.length) : null };
  }

  async get(id: string): Promise<Product> {
    const internalId = toInternalId(id);
    if (internalId === null) throw notFound(`Product '${id}' does not exist.`);

    const record = await this.products.findById(internalId);
    if (record === null) throw notFound(`Product '${id}' does not exist.`);
    return toProduct(record);
  }

  // The seller is the authenticated caller, never "the first user in the table".
  async create(input: CreateProduct, sellerId: string): Promise<Product> {
    const record = await this.products.insert({
      sellerId,
      name: input.title,
      priceMinor: input.price_cents,
      currency: input.currency,
      status: 'active',
    });
    return toProduct(record);
  }
}
