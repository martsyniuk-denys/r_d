import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';

import { Order } from './order.entity';

// The effect of consuming order.placed: one picking task per placed order. Both
// keys are natural — the event's id and the order it is about — so applying the
// same event twice is an INSERT that finds its row already there, not a second
// task. The row is the effect and the "already processed" mark at once.
@Entity('order_fulfilments')
@Index('order_fulfilments_order_unique', ['orderId'], { unique: true })
export class OrderFulfilment {
  @PrimaryColumn('text', { name: 'event_id' })
  eventId!: string;

  @Column('bigint', { name: 'order_id' })
  orderId!: string;

  @ManyToOne(() => Order, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order!: Order;

  @Column('integer', { name: 'line_count' })
  lineCount!: number;

  @Column('integer', { name: 'total_minor' })
  totalMinor!: number;

  @Column('text', { name: 'handled_by' })
  handledBy!: string;

  @Column('timestamptz', { name: 'created_at', default: () => 'now()' })
  createdAt!: Date;
}
