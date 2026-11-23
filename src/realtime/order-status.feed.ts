import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ChannelModel, ConsumeMessage } from 'amqplib';

import { OrderStatus } from '../entities/order.entity';
import { brokerAddress, connectBroker } from '../messaging/broker';
import { EVENTS_EXCHANGE, ORDER_STATUS_CHANGED, OrderStatusChangedEvent } from '../messaging/events';
import { declareTopology } from '../messaging/topology';
import { layerLogger } from '../observability/logger';
import { OrderEventsService } from './order-events.service';

const log = layerLogger('realtime.feed');
const RECONNECT_MS = 5000;

// The bridge from the broker to this instance's realtime bus. Each API instance
// declares its own exclusive, auto-delete queue bound to order.status_changed, so
// every instance gets every change — which is what lets a buyer connected to
// replica A hear about a payment that replica B accepted, or that the consumer
// process applied. Nothing durable rides on it: a missed live event is replayed
// from order_status_history on the next reconnect (Last-Event-ID).
@Injectable()
export class OrderStatusFeed implements OnModuleInit, OnApplicationShutdown {
  private connection?: ChannelModel;
  private stopping = false;
  private timer?: NodeJS.Timeout;

  constructor(private readonly events: OrderEventsService) {}

  get connected(): boolean {
    return this.connection !== undefined;
  }

  get enabled(): boolean {
    return (process.env.BROKER_URL ?? '') !== '';
  }

  onModuleInit(): void {
    if (!this.enabled) {
      log.warn('BROKER_URL is not set: no live order events (SSE still replays from history)');
      return;
    }
    void this.connect();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    await this.connection?.close().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    try {
      const connection = await connectBroker(`api-realtime-${process.pid}`);
      connection.on('close', () => this.lost());
      const channel = await connection.createChannel();
      await declareTopology(channel);
      const { queue } = await channel.assertQueue('', { exclusive: true, autoDelete: true, durable: false });
      await channel.bindQueue(queue, EVENTS_EXCHANGE, ORDER_STATUS_CHANGED);
      await channel.consume(queue, (message) => this.handle(message), { noAck: true });
      this.connection = connection;
      log.info({ broker: brokerAddress(), queue }, 'listening for order status changes');
    } catch (error) {
      log.warn({ err: error }, 'broker unavailable; retrying');
      this.retry();
    }
  }

  private lost(): void {
    this.connection = undefined;
    if (!this.stopping) {
      log.warn('broker connection closed; reconnecting');
      this.retry();
    }
  }

  private retry(): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => void this.connect(), RECONNECT_MS);
    this.timer.unref();
  }

  private handle(message: ConsumeMessage | null): void {
    if (message === null) return;
    try {
      const event = JSON.parse(message.content.toString('utf8')) as OrderStatusChangedEvent;
      this.events.publish({
        id: Number(event.data.historyId),
        order_id: `o_${event.data.orderId}`,
        status: event.data.status as OrderStatus,
        previous_status: event.data.previousStatus as OrderStatus | null,
        changed_at: event.occurredAt,
      });
    } catch (error) {
      log.warn({ err: error }, 'unreadable order.status_changed; skipped');
    }
  }
}
