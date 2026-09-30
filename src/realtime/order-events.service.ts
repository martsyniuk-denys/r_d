import { Injectable } from '@nestjs/common';
import { Observable, Subject, concat, defer, filter, from } from 'rxjs';

export const ORDER_STATUS_EVENT = 'order.status';

export type OrderStatus = 'created' | 'paid' | 'cancelled';

export interface OrderStatusEvent {
  id: number;
  order_id: string;
  status: OrderStatus;
  previous_status: OrderStatus;
  changed_at: string;
}

const BUFFER_SIZE = 100;

// One bus, two transports. The gateway and the SSE controller are both
// subscribers here; neither knows the other exists, and the status change that
// feeds them is published once, from the service that performs it.
@Injectable()
export class OrderEventsService {
  private readonly events = new Subject<OrderStatusEvent>();
  private readonly buffers = new Map<string, OrderStatusEvent[]>();
  private readonly sequences = new Map<string, number>();

  publish(orderId: string, status: OrderStatus, previousStatus: OrderStatus): OrderStatusEvent {
    const id = (this.sequences.get(orderId) ?? 0) + 1;
    this.sequences.set(orderId, id);

    const event: OrderStatusEvent = {
      id,
      order_id: orderId,
      status,
      previous_status: previousStatus,
      changed_at: new Date().toISOString(),
    };

    const buffer = this.buffers.get(orderId) ?? [];
    buffer.push(event);
    if (buffer.length > BUFFER_SIZE) buffer.splice(0, buffer.length - BUFFER_SIZE);
    this.buffers.set(orderId, buffer);

    this.events.next(event);
    return event;
  }

  all(): Observable<OrderStatusEvent> {
    return this.events.asObservable();
  }

  missed(orderId: string, lastEventId: number): OrderStatusEvent[] {
    return (this.buffers.get(orderId) ?? []).filter((event) => event.id > lastEventId);
  }

  // Replay, then live. The buffer is read at subscribe time and the live stream
  // is filtered past whatever the replay already handed over, so a reconnect
  // with Last-Event-ID can neither skip an event nor see one twice.
  since(orderId: string, lastEventId: number): Observable<OrderStatusEvent> {
    return defer(() => {
      const replay = this.missed(orderId, lastEventId);
      const delivered = replay.length > 0 ? replay[replay.length - 1].id : lastEventId;

      return concat(
        from(replay),
        this.events.pipe(filter((event) => event.order_id === orderId && event.id > delivered)),
      );
    });
  }
}
