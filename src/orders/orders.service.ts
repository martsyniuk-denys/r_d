import { Injectable } from '@nestjs/common';

import { Page, paginate } from '../common/cursor';
import { ProductsService } from '../products/products.service';
import { OrderEventsService, OrderStatus } from '../realtime/order-events.service';

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

export interface CreateOrderLine {
  product_id: string;
  qty: number;
}

@Injectable()
export class OrdersService {
  private readonly orders: Order[] = [];
  private seq = 0;

  constructor(
    private readonly products: ProductsService,
    private readonly events: OrderEventsService,
  ) {}

  list(limit: number, cursor?: string): Page<Order> {
    return paginate(this.orders, limit, cursor);
  }

  get(id: string): Order | undefined {
    return this.orders.find((o) => o.id === id);
  }

  async create(lines: CreateOrderLine[], buyerId: string | null): Promise<Order> {
    const items: OrderItem[] = [];
    for (const line of lines) {
      const product = await this.products.get(line.product_id);
      items.push({ product_id: product.id, qty: line.qty, unit_price_cents: product.price_cents });
    }

    const order: Order = {
      id: `o_${++this.seq}`,
      status: 'created',
      buyer_id: buyerId,
      currency: 'UAH',
      items,
      total_cents: items.reduce((sum, i) => sum + i.unit_price_cents * i.qty, 0),
      created_at: new Date().toISOString(),
    };
    this.orders.push(order);
    return order;
  }

  // The realtime notification is emitted here, from the operation that changes
  // the status, not from the controller: every caller of this method — HTTP
  // today, a queue consumer later — notifies the connected clients by doing so.
  setStatus(order: Order, status: OrderStatus): Order {
    const previous = order.status;
    order.status = status;
    this.events.publish(order.id, status, previous);
    return order;
  }
}
