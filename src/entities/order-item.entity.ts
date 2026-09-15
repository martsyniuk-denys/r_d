import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

import { Order } from './order.entity';
import { Product } from './product.entity';

@Entity('order_items')
@Unique('order_items_order_product_unique', ['orderId', 'productId'])
@Check('order_items_qty_positive', 'qty > 0')
@Check('order_items_unit_price_non_negative', 'unit_price_minor >= 0')
export class OrderItem {
  @PrimaryGeneratedColumn('identity', { type: 'bigint', generatedIdentity: 'ALWAYS' })
  id!: string;

  @Column('bigint', { name: 'order_id' })
  orderId!: string;

  @ManyToOne(() => Order, (order) => order.items, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order!: Order;

  @Column('bigint', { name: 'product_id' })
  productId!: string;

  @ManyToOne(() => Product, (product) => product.orderItems, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'product_id' })
  product!: Product;

  @Column('integer')
  qty!: number;

  @Column('integer', { name: 'unit_price_minor' })
  unitPriceMinor!: number;
}
