import { Injectable } from '@nestjs/common';

import { Page, paginate } from '../common/cursor';
import { ProductsService } from '../products/products.service';

export interface OrderItem {
  product_id: string;
  qty: number;
  unit_price_cents: number;
}

export interface Order {
  id: string;
  status: 'created' | 'paid' | 'cancelled';
  currency: 'UAH' | 'USD' | 'EUR';
  items: OrderItem[];
  total_cents: number;
  created_at: string;
}

export interface CreateOrderLine {
  product_id: string;
  qty: number;
}

@Injectable()
export class OrdersService {
  private readonly orders: Order[] = [];
  private seq = 0;

  constructor(private readonly products: ProductsService) {}

  list(limit: number, cursor?: string): Page<Order> {
    return paginate(this.orders, limit, cursor);
  }

  get(id: string): Order | undefined {
    return this.orders.find((o) => o.id === id);
  }

  create(lines: CreateOrderLine[]): Order {
    const items: OrderItem[] = lines.map((line) => {
      const product = this.products.get(line.product_id);
      return { product_id: product.id, qty: line.qty, unit_price_cents: product.price_cents };
    });

    const order: Order = {
      id: `o_${++this.seq}`,
      status: 'created',
      currency: 'UAH',
      items,
      total_cents: items.reduce((sum, i) => sum + i.unit_price_cents * i.qty, 0),
      created_at: new Date().toISOString(),
    };
    this.orders.push(order);
    return order;
  }
}
