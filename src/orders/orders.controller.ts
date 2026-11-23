import { Body, Controller, Get, Headers, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';

import { AccessTokenGuard, CurrentPrincipal, Roles, RolesGuard } from '../auth/guards';
import { Principal } from '../auth/principal';
import { Page } from '../common/cursor';
import { ProblemError, forbidden, notFound, unauthorized } from '../common/problem';
import { layerLogger } from '../observability/logger';
import { AccessDenial, access } from '../realtime/order-access';
import {
  ORDER_STATUS_EVENT,
  OrderEventsService,
  OrderStatus,
  OrderStatusEvent,
} from '../realtime/order-events.service';
import { CreateOrderLine, Order, OrderHistoryEntry, OrdersService } from './orders.service';

const log = layerLogger('orders.controller');
const SSE_RETRY_MS = 1000;
const SSE_KEEPALIVE_MS = 15000;

interface CreateOrderBody {
  items: CreateOrderLine[];
}

interface UpdateStatusBody {
  status: OrderStatus;
}

// Every route here needs a token (401 without one). Which order a caller may
// touch is not decided by a guard: it is decided after the order is loaded, by
// access() — or, for the list, by filtering on the buyer while reading.
@Controller('orders')
@UseGuards(AccessTokenGuard)
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly events: OrderEventsService,
  ) {}

  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<Page<Order>> {
    return this.orders.listFor(principal, Number(limit ?? 20), cursor);
  }

  // The buyer is the subject of the verified token — there is no header or body
  // field through which a caller could name somebody else. The Idempotency-Key is
  // scoped to that buyer and stored with the order in one transaction, so a retry
  // after a timeout, a restart or on another replica replays the same order.
  @Post()
  async create(
    @Headers('idempotency-key') key: string,
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateOrderBody,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Order> {
    log.info({ lines: body.items.length }, 'checkout requested');
    const { order, replayed } = await this.orders.create(key, body.items, principal.userId);
    if (replayed) res.setHeader('Idempotency-Replay', 'true');
    log.info({ orderId: order.id, replayed }, 'checkout answered');
    return order;
  }

  @Get(':orderId')
  async get(@Param('orderId') orderId: string, @CurrentPrincipal() principal: Principal): Promise<Order> {
    return this.owned(orderId, principal);
  }

  // The order's life as the database recorded it: every transition, who made it
  // and when — the separate read that shows what the background part did.
  @Get(':orderId/history')
  async history(
    @Param('orderId') orderId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ items: OrderHistoryEntry[] }> {
    return { items: await this.orders.history(await this.owned(orderId, principal)) };
  }

  // Role by the guard, existence by the read. Buyers move their orders only through
  // checkout and payment; a status written by hand is an operator's action.
  @Patch(':orderId/status')
  @UseGuards(RolesGuard)
  @Roles('admin')
  async updateStatus(
    @Param('orderId') orderId: string,
    @CurrentPrincipal() principal: Principal,
    @Body() body: UpdateStatusBody,
  ): Promise<Order> {
    const order = await this.owned(orderId, principal);
    return this.orders.setStatus(order, body.status, principal);
  }

  // Raw @Res(): the response is a stream this method writes to over minutes, not
  // a value Nest serialises once. The same events the gateway pushes into the
  // room are written here as SSE frames, off the same bus.
  @Get(':orderId/events')
  async streamEvents(
    @Param('orderId') orderId: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.owned(orderId, principal);

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
      .subscribe({
        next: (event: OrderStatusEvent) => {
          res.write(`id: ${event.id}\n`);
          res.write(`event: ${ORDER_STATUS_EVENT}\n`);
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        },
        // The replay could not be read: end the stream; the client reconnects with
        // its Last-Event-ID after `retry`.
        error: (err: unknown) => {
          log.warn({ err, orderId }, 'order event stream failed');
          res.end();
        },
      });

    const keepalive = setInterval(() => res.write(': keepalive\n\n'), SSE_KEEPALIVE_MS);

    req.on('close', () => {
      clearInterval(keepalive);
      subscription.unsubscribe();
      res.end();
    });
  }

  private async owned(orderId: string, principal: Principal): Promise<Order> {
    const allowed = access(orderId, await this.orders.find(orderId), principal);
    if (!allowed.ok) throw asProblem(allowed.denial);
    return allowed.order;
  }
}

function parseLastEventId(header: string | undefined): number {
  const parsed = Number.parseInt(header ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function asProblem(denial: AccessDenial): ProblemError {
  switch (denial.reason) {
    case 'not_found':
      return notFound(denial.detail);
    case 'anonymous':
      return unauthorized(denial.detail);
    case 'forbidden':
      return forbidden(denial.detail);
  }
}
