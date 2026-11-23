import { OrderStatus } from '../../src/entities/order.entity';
import { PaymentWebhook, applyPayment } from '../../src/payments/apply-payment';
import { OrdersRepository } from '../../src/repositories';
import { anOrder } from '../testkit/builders';
import { withRollback } from '../testkit/rollback';

describe('payment webhooks against a real Postgres', () => {
  const ctx = withRollback();
  let events = 0;

  // An order as the checkout leaves it: the amount frozen in payment_intents.
  const anOrderAwaitingPayment = async (status: OrderStatus = 'confirmed', amountMinor = 54_900) => {
    const order = await anOrder().withStatus(status).create(ctx.db());
    await ctx.db().query(`INSERT INTO payment_intents (order_id, amount_minor, currency) VALUES ($1, $2, 'UAH')`, [
      order.id,
      amountMinor,
    ]);
    return { id: order.id, amountMinor };
  };

  const webhook = (order: { id: string; amountMinor: number }, overrides: Partial<PaymentWebhook> = {}): PaymentWebhook => ({
    event_id: `evt_it_${++events}`,
    order_id: `o_${order.id}`,
    amount_cents: order.amountMinor,
    currency: 'UAH',
    outcome: 'succeeded',
    ...overrides,
  });

  const stateOf = async (orderId: string) => {
    const intent = await ctx.db().query<{ status: string }>(`SELECT status FROM payment_intents WHERE order_id = $1`, [orderId]);
    const journal = await ctx.db().query<{ provider_event_id: string; verdict: string }>(
      `SELECT provider_event_id, verdict FROM payment_events WHERE order_id = $1 ORDER BY id`,
      [orderId],
    );
    const history = await new OrdersRepository(ctx.db()).history(orderId);
    const order = await new OrdersRepository(ctx.db()).findById(orderId);
    return {
      order: order?.status,
      intent: intent.rows[0]?.status,
      journal: journal.rows.map((r) => [r.provider_event_id, r.verdict]),
      history: history.map((h) => [h.previousStatus, h.status, h.changedBy]),
    };
  };

  it('pays a confirmed order: journal, intent, status and history in one go', async () => {
    const order = await anOrderAwaitingPayment('confirmed');
    const paid = webhook(order);

    await expect(applyPayment(ctx.db(), order.id, paid)).resolves.toEqual({
      event_id: paid.event_id,
      order_id: paid.order_id,
      verdict: 'applied',
      order_status: 'paid',
    });

    await expect(stateOf(order.id)).resolves.toEqual({
      order: 'paid',
      intent: 'succeeded',
      journal: [[paid.event_id, 'applied']],
      history: [['confirmed', 'paid', 'payment-webhook']],
    });
  });

  it('pays a pending order too — the provider may answer before the consumer', async () => {
    const order = await anOrderAwaitingPayment('pending');

    await expect(applyPayment(ctx.db(), order.id, webhook(order))).resolves.toMatchObject({ verdict: 'applied' });
    await expect(stateOf(order.id)).resolves.toMatchObject({ order: 'paid', history: [['pending', 'paid', 'payment-webhook']] });
  });

  it('answers a redelivery as a duplicate and applies nothing a second time', async () => {
    const order = await anOrderAwaitingPayment();
    const paid = webhook(order);
    await applyPayment(ctx.db(), order.id, paid);
    const once = await stateOf(order.id);

    await expect(applyPayment(ctx.db(), order.id, paid)).resolves.toMatchObject({ verdict: 'duplicate', order_status: 'paid' });
    await expect(stateOf(order.id)).resolves.toEqual(once);
  });

  it('journals an amount that differs from the frozen one and leaves the order where it was', async () => {
    const order = await anOrderAwaitingPayment('confirmed', 54_900);
    const short = webhook(order, { amount_cents: 100 });

    await expect(applyPayment(ctx.db(), order.id, short)).resolves.toMatchObject({
      verdict: 'amount_mismatch',
      order_status: 'confirmed',
    });
    await expect(stateOf(order.id)).resolves.toEqual({
      order: 'confirmed',
      intent: 'requires_payment',
      journal: [[short.event_id, 'amount_mismatch']],
      history: [],
    });
  });

  it('treats the right amount in another currency as a mismatch too', async () => {
    const order = await anOrderAwaitingPayment();

    await expect(applyPayment(ctx.db(), order.id, webhook(order, { currency: 'USD' }))).resolves.toMatchObject({
      verdict: 'amount_mismatch',
    });
    await expect(stateOf(order.id)).resolves.toMatchObject({ order: 'confirmed', intent: 'requires_payment' });
  });

  it('marks the intent failed on a failed payment; the order stays payable', async () => {
    const order = await anOrderAwaitingPayment();
    const failed = webhook(order, { outcome: 'failed' });

    await expect(applyPayment(ctx.db(), order.id, failed)).resolves.toMatchObject({ verdict: 'ignored', order_status: 'confirmed' });
    await expect(stateOf(order.id)).resolves.toMatchObject({ order: 'confirmed', intent: 'failed', history: [] });

    // the buyer retries and the next attempt goes through
    await expect(applyPayment(ctx.db(), order.id, webhook(order))).resolves.toMatchObject({ verdict: 'applied' });
    await expect(stateOf(order.id)).resolves.toMatchObject({ order: 'paid', intent: 'succeeded' });
  });

  it('journals money for a cancelled order as ignored and does not move it', async () => {
    const order = await anOrderAwaitingPayment('cancelled');
    const late = webhook(order);

    await expect(applyPayment(ctx.db(), order.id, late)).resolves.toMatchObject({ verdict: 'ignored', order_status: 'cancelled' });
    await expect(stateOf(order.id)).resolves.toEqual({
      order: 'cancelled',
      intent: 'requires_payment',
      journal: [[late.event_id, 'ignored']],
      history: [],
    });
  });

  it('answers 404 for an order with no payment intent', async () => {
    const order = await anOrder().withStatus('confirmed').create(ctx.db());

    await expect(applyPayment(ctx.db(), order.id, webhook({ id: order.id, amountMinor: 1 }))).rejects.toMatchObject({
      status: 404,
    });
  });

  it('keeps the journal: an order with payment events cannot be deleted (ON DELETE RESTRICT)', async () => {
    const order = await anOrderAwaitingPayment();
    await applyPayment(ctx.db(), order.id, webhook(order));

    await ctx.attempt(async () => {
      await expect(new OrdersRepository(ctx.db()).delete(order.id)).rejects.toMatchObject({
        code: '23503',
        constraint: 'FK_payment_events_order',
      });
    });
  });

  it('refuses a verdict outside the list (CHECK constraint)', async () => {
    const order = await anOrderAwaitingPayment();

    await ctx.attempt(async () => {
      await expect(
        ctx.db().query(
          `INSERT INTO payment_events (provider_event_id, order_id, amount_minor, currency, outcome, verdict)
           VALUES ('evt_bad', $1, 1, 'UAH', 'succeeded', 'maybe')`,
          [order.id],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'payment_events_verdict_known' });
    });
  });
});
