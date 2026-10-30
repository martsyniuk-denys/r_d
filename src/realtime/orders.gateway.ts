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

import { AuthService } from '../auth/auth.service';
import { Principal } from '../auth/principal';
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
    private readonly auth: AuthService,
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
  async join(@ConnectedSocket() client: Socket, @MessageBody() message: JoinMessage): Promise<JoinAck> {
    const orderId = typeof message?.orderId === 'string' ? message.orderId : null;
    if (orderId === null) {
      return { ok: false, reason: 'bad_request', detail: "join needs a string 'orderId'." };
    }

    const allowed = access(orderId, this.orders.get(orderId), await this.principalOf(client));
    if (!allowed.ok) {
      const { reason, detail } = allowed.denial;
      this.logger.warn(`join refused (${reason}): ${detail}`);
      return { ok: false, reason, detail };
    }

    const room = roomOf(orderId);
    client.join(room);
    return { ok: true, room };
  }

  // The same access token as over HTTP, from the handshake: io(url, { auth: { token } }).
  // Verified on every join rather than once per connection, so a token revoked by
  // logout stops opening rooms on a socket that is already connected.
  private async principalOf(client: Socket): Promise<Principal | null> {
    const token = (client.handshake.auth as Record<string, unknown> | undefined)?.token;
    if (typeof token !== 'string' || token.length === 0) return null;
    try {
      return await this.auth.verifyAccess(token);
    } catch {
      return null;
    }
  }
}
