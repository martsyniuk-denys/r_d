import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';

import { ProblemError, TYPE_BASE, notFound, unauthorized } from '../common/problem';
import { Env } from '../config/env.schema';
import { PG_POOL } from '../db/database.module';
import { layerLogger } from '../observability/logger';
import { toInternalOrderId } from '../orders/orders.service';
import { PaymentWebhook, WebhookReceipt, applyPayment } from './apply-payment';
import { verify } from './signature';

export type { PaymentWebhook, WebhookReceipt } from './apply-payment';

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
      receipt = await applyPayment(client, orderId, webhook);
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
}
