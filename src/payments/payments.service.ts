import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient } from 'pg';

import { ProblemError, TYPE_BASE, notFound, unauthorized } from '../common/problem';
import { Env } from '../config/env.schema';
import { PG_POOL } from '../db/database.module';
import { Currency } from '../entities/product.entity';
import { OrderStatus } from '../entities/order.entity';
import { PaymentOutcome, PaymentVerdict } from '../entities/payment.entity';
import { layerLogger } from '../observability/logger';
import { transition } from '../orders/lifecycle';
import { toInternalOrderId } from '../orders/orders.service';
import { verify } from './signature';

export interface PaymentWebhook {
  event_id: string;
  order_id: string;
  amount_cents: number;
  currency: Currency;
  outcome: PaymentOutcome;
}

export interface WebhookReceipt {
  event_id: string;
  order_id: string;
  verdict: PaymentVerdict | 'duplicate';
  order_status: OrderStatus;
}

interface IntentRow {
  amount_minor: number;
  currency: Currency;
  status: OrderStatus;
}

const log = layerLogger('payments.service');

export const amountMismatch = (detail: string): ProblemError =>
  new ProblemError({ status: 422, title: 'Unprocessable Entity', detail, type: `${TYPE_BASE}/amount-mismatch` });

// What a payment webhook may and may not do:
//
//   signature   HMAC over the raw body, or 401 — before anything is read from it
//   duplicate   the provider's event id is UNIQUE in payment_events: a redelivery is
//               an INSERT that finds its row, answered 200 with no second effect
//   amount      compared with payment_intents, frozen at checkout. A mismatch is
//               journaled and answered 422; the order does not move
//   effect      succeeded → the order becomes paid, in the same transaction as the
//               journal row, its history entry and its outbox event
@Injectable()
export class PaymentsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly config: ConfigService<Env, true>,
  ) {}

  authenticate(rawBody: Buffer | undefined, signature: string | undefined): void {
    const secret = this.config.get('PAYMENT_WEBHOOK_SECRET', { infer: true });
    if (rawBody === undefined || !verify(rawBody, signature, secret)) {
      log.warn({ signed: signature !== undefined }, 'webhook signature rejected');
      throw unauthorized('The webhook signature does not match its body.');
    }
  }

  async handle(webhook: PaymentWebhook): Promise<WebhookReceipt> {
    const orderId = toInternalOrderId(webhook.order_id);
    if (orderId === null) throw notFound(`Order '${webhook.order_id}' does not exist.`);

    const client = await this.pool.connect();
    let receipt: WebhookReceipt;
    try {
      await client.query('BEGIN');
      receipt = await this.apply(client, orderId, webhook);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    log.info({ eventId: webhook.event_id, orderId: webhook.order_id, verdict: receipt.verdict }, 'webhook handled');
    if (receipt.verdict === 'amount_mismatch') {
      throw amountMismatch(
        `Payment ${webhook.event_id} is for ${webhook.amount_cents} ${webhook.currency}, ` +
          `which is not the amount frozen for order '${webhook.order_id}'.`,
      );
    }
    return receipt;
  }

  private async apply(db: PoolClient, orderId: string, webhook: PaymentWebhook): Promise<WebhookReceipt> {
    // Locks the intent: two deliveries of different events for one order queue here.
    const { rows } = await db.query<IntentRow>(
      `SELECT pi.amount_minor, pi.currency, o.status
         FROM payment_intents pi
         JOIN orders o ON o.id = pi.order_id
        WHERE pi.order_id = $1
          FOR UPDATE OF pi`,
      [orderId],
    );
    if (rows.length === 0) throw notFound(`Order '${webhook.order_id}' has no payment to confirm.`);
    const intent = rows[0];

    const matches = intent.amount_minor === webhook.amount_cents && intent.currency === webhook.currency;
    const verdict: PaymentVerdict = !matches ? 'amount_mismatch' : webhook.outcome === 'succeeded' ? 'applied' : 'ignored';

    const journaled = await db.query(
      `INSERT INTO payment_events (provider_event_id, order_id, amount_minor, currency, outcome, verdict)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (provider_event_id) DO NOTHING
       RETURNING id`,
      [webhook.event_id, orderId, webhook.amount_cents, webhook.currency, webhook.outcome, verdict],
    );
    const receipt = (v: WebhookReceipt['verdict'], status: OrderStatus): WebhookReceipt => ({
      event_id: webhook.event_id,
      order_id: webhook.order_id,
      verdict: v,
      order_status: status,
    });

    if (journaled.rowCount === 0) return receipt('duplicate', intent.status);
    if (verdict === 'amount_mismatch') return receipt(verdict, intent.status);

    if (webhook.outcome === 'failed') {
      await db.query(`UPDATE payment_intents SET status = 'failed', updated_at = now() WHERE order_id = $1`, [orderId]);
      return receipt(verdict, intent.status);
    }

    const moved = await transition(db, { orderId, to: 'paid', changedBy: 'payment-webhook' });
    if (moved.kind !== 'changed') {
      // Paid for an order that can no longer be paid (cancelled meanwhile): the
      // money is journaled, the order does not move — a refund is a human's call.
      await db.query(`UPDATE payment_events SET verdict = 'ignored' WHERE provider_event_id = $1`, [webhook.event_id]);
      return receipt('ignored', intent.status);
    }
    await db.query(`UPDATE payment_intents SET status = 'succeeded', updated_at = now() WHERE order_id = $1`, [orderId]);
    return receipt('applied', 'paid');
  }
}
