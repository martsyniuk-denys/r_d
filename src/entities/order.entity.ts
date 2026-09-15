import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Currency } from './product.entity';
import { OrderItem } from './order-item.entity';
import { User } from './user.entity';

export const ORDER_STATUSES = ['pending', 'paid', 'shipped', 'cancelled', 'refunded'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

@Entity('orders')
@Index('idx_orders_buyer_created_at', ['buyerId', 'createdAt'])
@Index('idx_orders_refunded_created_at', ['createdAt'], { where: "status = 'refunded'" })
@Check('orders_total_non_negative', 'total_minor >= 0')
@Check('orders_currency_known', "currency IN ('UAH', 'USD', 'EUR')")
@Check(
  'orders_status_known',
  "status IN ('pending', 'paid', 'shipped', 'cancelled', 'refunded')",
)
export class Order {
  @PrimaryGeneratedColumn('identity', { type: 'bigint', generatedIdentity: 'ALWAYS' })
  id!: string;

  @Column('bigint', { name: 'buyer_id' })
  buyerId!: string;

  @ManyToOne(() => User, (user) => user.orders, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'buyer_id' })
  buyer!: User;

  @Column('text')
  status!: OrderStatus;

  @Column('integer', { name: 'total_minor' })
  totalMinor!: number;

  @Column('text')
  currency!: Currency;

  @Column('timestamptz', { name: 'created_at', default: () => 'now()' })
  createdAt!: Date;

  @OneToMany(() => OrderItem, (item) => item.order)
  items!: OrderItem[];
}
