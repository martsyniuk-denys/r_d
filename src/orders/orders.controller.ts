import { Body, Controller, Get, Headers, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';

import { IdempotencyService } from '../common/idempotency.service';
import { Page } from '../common/cursor';
import { ProblemError, forbidden, notFound } from '../common/problem';
import { AccessDenial, access } from '../realtime/order-access';
import {
  ORDER_STATUS_EVENT,
  OrderEventsService,
  OrderStatus,
  OrderStatusEvent,
} from '../realtime/order-events.service';
import { CreateOrderLine, Order, OrdersService } from './orders.service';

const ROUTE = 'POST /orders';
const SSE_RETRY_MS = 1000;
const SSE_KEEPALIVE_MS = 15000;

interface CreateOrderBody {
  items: CreateOrderLine[];
}

interface UpdateStatusBody {
  status: OrderStatus;
}

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly idempotency: IdempotencyService,
    private readonly events: OrderEventsService,
  ) {}

  @Get()
  list(@Query('limit') limit?: string, @Query('cursor') cursor?: string): Page<Order> {
    return this.orders.list(Number(limit ?? 20), cursor);
  }

  @Post()
  async create(
    @Headers('idempotency-key') key: string,
    @Headers('x-user-id') buyerId: string | undefined,
    @Body() body: CreateOrderBody,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Order> {
    const result = await this.idempotency.run(ROUTE, key, body, () =>
      this.orders.create(body.items, buyerId ?? null),
    );
    if (result.replayed) res.setHeader('Idempotency-Replay', 'true');
    return result.body;
  }

  @Get(':orderId')
  get(@Param('orderId') orderId: string): Order {
    const order = this.orders.get(orderId);
    if (!order) throw notFound(`Order '${orderId}' does not exist.`);
    return order;
  }

  @Patch(':orderId/status')
  updateStatus(
    @Param('orderId') orderId: string,
    @Headers('x-user-id') userId: string | undefined,
    @Body() body: UpdateStatusBody,
  ): Order {
    const allowed = access(orderId, this.orders.get(orderId), userId ?? null);
    if (!allowed.ok) throw asProblem(allowed.denial);

    return this.orders.setStatus(allowed.order, body.status);
  }

  // Raw @Res(): the response is a stream this method writes to over minutes, not
  // a value Nest serialises once. The same events the gateway pushes into the
  // room are written here as SSE frames, off the same bus.
  @Get(':orderId/events')
  streamEvents(
    @Param('orderId') orderId: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Headers('x-user-id') headerUserId: string | undefined,
    @Query('userId') queryUserId: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): void {
    const identity = headerUserId ?? queryUserId ?? null;
    const allowed = access(orderId, this.orders.get(orderId), identity);
    if (!allowed.ok) throw asProblem(allowed.denial);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write(`retry: ${SSE_RETRY_MS}\n\n`);

    const subscription = this.events
      .since(orderId, parseLastEventId(lastEventId))
      .subscribe((event: OrderStatusEvent) => {
        res.write(`id: ${event.id}\n`);
        res.write(`event: ${ORDER_STATUS_EVENT}\n`);
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      });

    const keepalive = setInterval(() => res.write(': keepalive\n\n'), SSE_KEEPALIVE_MS);

    req.on('close', () => {
      clearInterval(keepalive);
      subscription.unsubscribe();
      res.end();
    });
  }
}

function parseLastEventId(header: string | undefined): number {
  const parsed = Number.parseInt(header ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function asProblem(denial: AccessDenial): ProblemError {
  return denial.reason === 'not_found' ? notFound(denial.detail) : forbidden(denial.detail);
}
