import { Body, Controller, Get, Headers, Param, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';

import { IdempotencyService } from '../common/idempotency.service';
import { Page } from '../common/cursor';
import { notFound } from '../common/problem';
import { CreateOrderLine, Order, OrdersService } from './orders.service';

const ROUTE = 'POST /orders';

interface CreateOrderBody {
  items: CreateOrderLine[];
}

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  list(@Query('limit') limit?: string, @Query('cursor') cursor?: string): Page<Order> {
    return this.orders.list(Number(limit ?? 20), cursor);
  }

  @Post()
  create(
    @Headers('idempotency-key') key: string,
    @Body() body: CreateOrderBody,
    @Res({ passthrough: true }) res: Response,
  ): Order {
    const result = this.idempotency.run(ROUTE, key, body, () => this.orders.create(body.items));
    if (result.replayed) res.setHeader('Idempotency-Replay', 'true');
    return result.body;
  }

  @Get(':orderId')
  get(@Param('orderId') orderId: string): Order {
    const order = this.orders.get(orderId);
    if (!order) throw notFound(`Order '${orderId}' does not exist.`);
    return order;
  }
}
