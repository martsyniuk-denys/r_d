import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';

import { Order } from './order.entity';
import { User } from './user.entity';

// The API-edge key: one row per (buyer, Idempotency-Key), claimed in the same
// transaction that places the order. The key names the intent; request_hash is
// kept only to refuse the same key sent with a different body.
@Entity('idempotency_keys')
export class IdempotencyKey {
  @PrimaryColumn('bigint', { name: 'buyer_id' })
  buyerId!: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'buyer_id' })
  buyer!: User;

  @PrimaryColumn('text')
  key!: string;

  @Column('text', { name: 'request_hash' })
  requestHash!: string;

  // NULL only inside the claiming transaction, between the claim and the order.
  @Column('bigint', { name: 'order_id', nullable: true })
  orderId!: string | null;

  @ManyToOne(() => Order, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order!: Order | null;

  @Column('timestamptz', { name: 'created_at', default: () => 'now()' })
  createdAt!: Date;
}
