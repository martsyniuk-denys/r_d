import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { Observable, Subject, filter } from 'rxjs';

import { PG_POOL } from '../db/database.module';
import { OrderStatus } from '../entities/order.entity';
import { OrdersRepository } from '../repositories';

export const ORDER_STATUS_EVENT = 'order.status';

export type { OrderStatus };

export interface OrderStatusEvent {
  // order_status_history.id: increasing per order, and the SSE `id:` field.
  id: number;
  order_id: string;
  status: OrderStatus;
  previous_status: OrderStatus | null;
  changed_at: string;
}

// One bus, two transports. The gateway and the SSE controller are both
// subscribers here; neither knows the other exists. What feeds the bus is
// OrderStatusFeed: every order.status_changed the relay puts on the broker,
// whichever process — this API, another replica, the consumer — made the change.
//
// The history table, not memory, is the replay buffer: a reconnect with
// Last-Event-ID is answered from order_status_history, so it survives a restart
// and works against any replica.
@Injectable()
export class OrderEventsService {
  private readonly events = new Subject<OrderStatusEvent>();
  private readonly orders: OrdersRepository;

  constructor(@Inject(PG_POOL) pool: Pool) {
    this.orders = new OrdersRepository(pool);
  }

  publish(event: OrderStatusEvent): void {
    this.events.next(event);
  }

  all(): Observable<OrderStatusEvent> {
    return this.events.asObservable();
  }

  // Replay, then live. The live stream is subscribed first and held back until the
  // replay is out, then everything past the last id already sent goes through — so
  // an event landing between the SELECT and the switch is neither lost nor doubled.
  since(publicOrderId: string, lastEventId: number): Observable<OrderStatusEvent> {
    const internalId = /^o_(\d{1,18})$/.exec(publicOrderId)?.[1];

    return new Observable<OrderStatusEvent>((subscriber) => {
      let delivered = lastEventId;
      let replaying = true;
      const held: OrderStatusEvent[] = [];
      const send = (event: OrderStatusEvent): void => {
        if (event.id <= delivered) return;
        delivered = event.id;
        subscriber.next(event);
      };

      const live = this.events
        .pipe(filter((event) => event.order_id === publicOrderId))
        .subscribe((event) => (replaying ? held.push(event) : send(event)));

      const replay = internalId === undefined ? Promise.resolve([]) : this.orders.history(internalId, String(lastEventId));
      replay
        .then((entries) => {
          for (const entry of entries) {
            send({
              id: Number(entry.id),
              order_id: publicOrderId,
              status: entry.status,
              previous_status: entry.previousStatus,
              changed_at: entry.changedAt.toISOString(),
            });
          }
          replaying = false;
          held.sort((a, b) => a.id - b.id).forEach(send);
        })
        .catch((error: unknown) => subscriber.error(error));

      return () => live.unsubscribe();
    });
  }
}
