import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { Order, OrderStatus } from './order.entity';

// One row per accepted transition, written in the transaction that made it. The id
// doubles as the realtime event id: SSE's Last-Event-ID replays from here.
@Entity('order_status_history')
@Index('idx_order_status_history_order', ['orderId', 'id'])
export class OrderStatusChange {
  @PrimaryGeneratedColumn('identity', {
    type: 'bigint',
    generatedIdentity: 'ALWAYS',
    primaryKeyConstraintName: 'PK_order_status_history_id',
  })
  id!: string;

  @Column('bigint', { name: 'order_id' })
  orderId!: string;

  @ManyToOne(() => Order, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id', foreignKeyConstraintName: 'FK_order_status_history_order' })
  order!: Order;

  @Column('text')
  status!: OrderStatus;

  @Column('text', { name: 'previous_status', nullable: true })
  previousStatus!: OrderStatus | null;

  // Who made the change: 'checkout', 'fulfilment', 'payment-webhook', or 'admin:<user id>'.
  @Column('text', { name: 'changed_by' })
  changedBy!: string;

  @Column('timestamptz', { name: 'changed_at', default: () => 'now()' })
  changedAt!: Date;
}
