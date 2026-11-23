import { Check, Column, Entity, Index, JoinColumn, ManyToOne, OneToOne, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';

import { Order } from './order.entity';
import { Currency } from './product.entity';

export const PAYMENT_INTENT_STATUSES = ['requires_payment', 'succeeded', 'failed'] as const;
export type PaymentIntentStatus = (typeof PAYMENT_INTENT_STATUSES)[number];

export const PAYMENT_OUTCOMES = ['succeeded', 'failed'] as const;
export type PaymentOutcome = (typeof PAYMENT_OUTCOMES)[number];

export const PAYMENT_VERDICTS = ['applied', 'amount_mismatch', 'ignored'] as const;
export type PaymentVerdict = (typeof PAYMENT_VERDICTS)[number];

// What the buyer agreed to pay, frozen in the checkout transaction. The webhook's
// amount is compared with this row, never trusted on its own.
@Entity('payment_intents')
@Check('payment_intents_amount_non_negative', 'amount_minor >= 0')
@Check('payment_intents_currency_known', "currency IN ('UAH', 'USD', 'EUR')")
@Check('payment_intents_status_known', "status IN ('requires_payment', 'succeeded', 'failed')")
export class PaymentIntent {
  @PrimaryColumn('bigint', { name: 'order_id', primaryKeyConstraintName: 'PK_payment_intents_order_id' })
  orderId!: string;

  @OneToOne(() => Order, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id', foreignKeyConstraintName: 'FK_payment_intents_order' })
  order!: Order;

  @Column('integer', { name: 'amount_minor' })
  amountMinor!: number;

  @Column('text')
  currency!: Currency;

  @Column('text', { default: 'requires_payment' })
  status!: PaymentIntentStatus;

  @Column('timestamptz', { name: 'created_at', default: () => 'now()' })
  createdAt!: Date;

  @Column('timestamptz', { name: 'updated_at', default: () => 'now()' })
  updatedAt!: Date;
}

// Append-only: every webhook that passed the signature check, once. The provider's
// event id is unique, so a redelivery finds its row instead of applying twice.
@Entity('payment_events')
@Index('idx_payment_events_order', ['orderId', 'id'])
@Check('payment_events_outcome_known', "outcome IN ('succeeded', 'failed')")
@Check('payment_events_verdict_known', "verdict IN ('applied', 'amount_mismatch', 'ignored')")
export class PaymentEvent {
  @PrimaryGeneratedColumn('identity', {
    type: 'bigint',
    generatedIdentity: 'ALWAYS',
    primaryKeyConstraintName: 'PK_payment_events_id',
  })
  id!: string;

  @Column('text', { name: 'provider_event_id', unique: true })
  providerEventId!: string;

  @Column('bigint', { name: 'order_id' })
  orderId!: string;

  @ManyToOne(() => Order, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'order_id', foreignKeyConstraintName: 'FK_payment_events_order' })
  order!: Order;

  @Column('integer', { name: 'amount_minor' })
  amountMinor!: number;

  @Column('text')
  currency!: Currency;

  @Column('text')
  outcome!: PaymentOutcome;

  @Column('text')
  verdict!: PaymentVerdict;

  @Column('timestamptz', { name: 'received_at', default: () => 'now()' })
  receivedAt!: Date;
}
