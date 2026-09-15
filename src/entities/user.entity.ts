import { Check, Column, Entity, Index, OneToMany, PrimaryGeneratedColumn } from 'typeorm';

import { Order } from './order.entity';
import { Product } from './product.entity';

@Entity('users')
@Index('users_email_unique', ['email'], { unique: true })
@Check('users_display_name_not_empty', 'length(display_name) > 0')
@Check('users_country_is_iso2', "country ~ '^[A-Z]{2}$'")
export class User {
  @PrimaryGeneratedColumn('identity', { type: 'bigint', generatedIdentity: 'ALWAYS' })
  id!: string;

  @Column('text')
  email!: string;

  @Column('text', { name: 'display_name' })
  displayName!: string;

  @Column('text')
  country!: string;

  @Column('timestamptz', { name: 'created_at', default: () => 'now()' })
  createdAt!: Date;

  @OneToMany(() => Product, (product) => product.seller)
  products!: Product[];

  @OneToMany(() => Order, (order) => order.buyer)
  orders!: Order[];
}
