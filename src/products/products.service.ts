import { Injectable } from '@nestjs/common';

import { Page, paginate } from '../common/cursor';
import { notFound } from '../common/problem';

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

const CATALOGUE: ReadonlyArray<[string, number]> = [
  ['Mechanical keyboard', 260000],
  ['Wireless mouse', 89000],
  ['27" monitor', 1149900],
  ['USB-C hub', 45000],
  ['ANC headphones', 799900],
  ['1080p webcam', 210000],
  ['Laptop stand', 68000],
];

@Injectable()
export class ProductsService {
  private readonly products: Product[] = [];
  private seq = 0;

  constructor() {
    for (const [title, price_cents] of CATALOGUE) {
      this.products.push({
        id: `p_${++this.seq}`,
        title,
        price_cents,
        currency: 'UAH',
        created_at: new Date(Date.UTC(2026, 0, this.seq, 10, 0, 0)).toISOString(),
      });
    }
  }

  list(limit: number, cursor?: string): Page<Product> {
    return paginate(this.products, limit, cursor);
  }

  get(id: string): Product {
    const product = this.products.find((p) => p.id === id);
    if (!product) throw notFound(`Product '${id}' does not exist.`);
    return product;
  }

  create(input: CreateProduct): Product {
    const product: Product = {
      id: `p_${++this.seq}`,
      title: input.title,
      price_cents: input.price_cents,
      currency: input.currency,
      created_at: new Date().toISOString(),
    };
    this.products.push(product);
    return product;
  }
}
