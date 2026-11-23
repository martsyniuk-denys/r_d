import { notFound } from '../common/problem';
import { OrderStatus } from '../entities/order.entity';
import { Currency } from '../entities/product.entity';
import { PaymentOutcome, PaymentVerdict } from '../entities/payment.entity';
import { transition } from '../orders/lifecycle';
import { Queryable } from '../repositories/queryable';

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

// One verified webhook, inside the caller's transaction: the journal row, the
// intent's status and the order's transition commit together or not at all.
// `db` must already be between BEGIN and COMMIT; `orderId` is the internal id.
export async function applyPayment(db: Queryable, orderId: string, webhook: PaymentWebhook): Promise<WebhookReceipt> {
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
