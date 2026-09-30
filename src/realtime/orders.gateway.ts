import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Subscription } from 'rxjs';
import { Server, Socket } from 'socket.io';

import { OrdersService } from '../orders/orders.service';
import { DenialReason, access } from './order-access';
import { ORDER_STATUS_EVENT, OrderEventsService, OrderStatusEvent } from './order-events.service';

export const roomOf = (orderId: string): string => `orders:${orderId}`;

interface JoinMessage {
  orderId?: unknown;
}

export type JoinAck =
  | { ok: true; room: string }
  | { ok: false; reason: DenialReason | 'bad_request'; detail: string };

// cors is open because the demo page and the headless client are served from
// wherever the reader happens to have them; the room guard, not the origin, is
// what keeps one buyer out of another buyer's order.
@WebSocketGateway({ cors: { origin: '*' } })
export class OrdersGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrdersGateway.name);
  private subscription?: Subscription;

  @WebSocketServer()
  private readonly server!: Server;

  constructor(
    private readonly orders: OrdersService,
    private readonly events: OrderEventsService,
  ) {}

  // The gateway is a subscriber of the bus, not its owner: it forwards whatever
  // the status change published into that order's room, and only there.
  onModuleInit(): void {
    this.subscription = this.events.all().subscribe((event: OrderStatusEvent) => {
      this.server?.to(roomOf(event.order_id)).emit(ORDER_STATUS_EVENT, event);
    });
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
  }

  @SubscribeMessage('join')
  join(@ConnectedSocket() client: Socket, @MessageBody() message: JoinMessage): JoinAck {
    const orderId = typeof message?.orderId === 'string' ? message.orderId : null;
    if (orderId === null) {
      return { ok: false, reason: 'bad_request', detail: "join needs a string 'orderId'." };
    }

    const allowed = access(orderId, this.orders.get(orderId), identityOf(client));
    if (!allowed.ok) {
      const { reason, detail } = allowed.denial;
      this.logger.warn(`join refused (${reason}): ${detail}`);
      return { ok: false, reason, detail };
    }

    const room = roomOf(orderId);
    client.join(room);
    return { ok: true, room };
  }
}

function identityOf(client: Socket): string | null {
  const fromAuth = (client.handshake.auth as Record<string, unknown> | undefined)?.userId;
  if (typeof fromAuth === 'string' && fromAuth.length > 0) return fromAuth;

  const fromQuery = client.handshake.query?.userId;
  if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;

  return null;
}
