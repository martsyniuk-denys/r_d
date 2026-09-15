import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { OrderItem } from './order-item.entity';
import { User } from './user.entity';

export const CURRENCIES = ['UAH', 'USD', 'EUR'] as const;
export type Currency = (typeof CURRENCIES)[number];

export const PRODUCT_STATUSES = ['draft', 'active', 'archived'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

@Entity('products')
@Check('products_name_not_empty', 'length(name) > 0')
@Check('products_price_non_negative', 'price_minor >= 0')
@Check('products_stock_non_negative', 'stock >= 0')
@Check('products_currency_known', "currency IN ('UAH', 'USD', 'EUR')")
@Check('products_status_known', "status IN ('draft', 'active', 'archived')")
export class Product {
  @PrimaryGeneratedColumn('identity', { type: 'bigint', generatedIdentity: 'ALWAYS' })
  id!: string;

  @Column('bigint', { name: 'seller_id' })
  sellerId!: string;

  @ManyToOne(() => User, (user) => user.products, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'seller_id' })
  seller!: User;

  @Column('text')
  name!: string;

  @Column('text', { default: '' })
  description!: string;

  @Column('integer', { name: 'price_minor' })
  priceMinor!: number;

  @Column('integer', { default: 0 })
  stock!: number;

  @Column('text')
  currency!: Currency;

  @Column('text')
  status!: ProductStatus;

  @Column('timestamptz', { name: 'created_at', default: () => 'now()' })
  createdAt!: Date;

  @Column({
    type: 'tsvector',
    name: 'search_vector',
    generatedType: 'STORED',
    asExpression: "to_tsvector('simple', name || ' ' || description)",
    select: false,
    insert: false,
    update: false,
  })
  searchVector!: string;

  @OneToMany(() => OrderItem, (item) => item.product)
  orderItems!: OrderItem[];
}
