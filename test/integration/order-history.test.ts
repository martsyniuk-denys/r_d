import { ORDER_STATUS_CHANGED } from '../../src/messaging/events';
import { recordStatus, transition } from '../../src/orders/lifecycle';
import { OrdersRepository } from '../../src/repositories';
import { aUser, anOrder } from '../testkit/builders';
import { testPool } from '../testkit/database';
import { withRollback } from '../testkit/rollback';

describe('order status history against a real Postgres', () => {
  const ctx = withRollback();
  const repo = (): OrdersRepository => new OrdersRepository(ctx.db());

  const outboxOf = async (orderId: string): Promise<{ type: string; payload: { data: Record<string, unknown> } }[]> => {
    const { rows } = await ctx.db().query(
      `SELECT type, payload FROM outbox WHERE aggregate_type = 'order' AND aggregate_id = $1 ORDER BY created_at`,
      [orderId],
    );
    return rows;
  };

  it('writes the row, its history entry and one outbox event in the same transaction', async () => {
    const order = await anOrder().withStatus('pending').create(ctx.db());
    await recordStatus(ctx.db(), { orderId: order.id, status: 'pending', previousStatus: null, changedBy: 'checkout' });

    const moved = await transition(ctx.db(), { orderId: order.id, to: 'confirmed', changedBy: 'fulfilment' });

    expect(moved).toMatchObject({ kind: 'changed', change: { status: 'confirmed', previousStatus: 'pending' } });
    await expect(repo().findById(order.id)).resolves.toMatchObject({ status: 'confirmed' });

    const history = await repo().history(order.id);
    expect(history.map((h) => [h.previousStatus, h.status, h.changedBy])).toEqual([
      [null, 'pending', 'checkout'],
      ['pending', 'confirmed', 'fulfilment'],
    ]);

    const events = await outboxOf(order.id);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(ORDER_STATUS_CHANGED);
    // the event names the history row it belongs to: the realtime id is that row's id
    expect(events[0].payload.data).toMatchObject({
      status: 'confirmed',
      previousStatus: 'pending',
      historyId: history[1].id,
    });
  });

  it('refuses a transition the table does not allow and leaves no trace of it', async () => {
    const order = await anOrder().withStatus('cancelled').create(ctx.db());

    const moved = await transition(ctx.db(), { orderId: order.id, to: 'paid', changedBy: 'payment-webhook' });

    expect(moved).toEqual({ kind: 'refused', current: 'cancelled' });
    await expect(repo().findById(order.id)).resolves.toMatchObject({ status: 'cancelled' });
    await expect(repo().history(order.id)).resolves.toEqual([]);
    await expect(outboxOf(order.id)).resolves.toEqual([]);
  });

  it('answers not-found for an order that does not exist', async () => {
    await expect(
      transition(ctx.db(), { orderId: '999999999', to: 'confirmed', changedBy: 'fulfilment' }),
    ).resolves.toEqual({ kind: 'not-found' });
  });

  it('replays only what came after the Last-Event-ID, in order', async () => {
    const order = await anOrder().withStatus('pending').create(ctx.db());
    await recordStatus(ctx.db(), { orderId: order.id, status: 'pending', previousStatus: null, changedBy: 'checkout' });
    await transition(ctx.db(), { orderId: order.id, to: 'confirmed', changedBy: 'fulfilment' });
    await transition(ctx.db(), { orderId: order.id, to: 'paid', changedBy: 'payment-webhook' });
    await transition(ctx.db(), { orderId: order.id, to: 'shipped', changedBy: 'admin:1' });

    const all = await repo().history(order.id);
    expect(all.map((h) => h.status)).toEqual(['pending', 'confirmed', 'paid', 'shipped']);

    const afterConfirmed = await repo().history(order.id, all[1].id);
    expect(afterConfirmed.map((h) => h.status)).toEqual(['paid', 'shipped']);
    await expect(repo().history(order.id, all[3].id)).resolves.toEqual([]);
  });

  it('keeps each order\'s history to itself', async () => {
    const buyer = await aUser().create(ctx.db());
    const a = await anOrder().placedBy(buyer).withStatus('pending').create(ctx.db());
    const b = await anOrder().placedBy(buyer).withStatus('pending').create(ctx.db());
    await transition(ctx.db(), { orderId: a.id, to: 'confirmed', changedBy: 'fulfilment' });
    await transition(ctx.db(), { orderId: b.id, to: 'cancelled', changedBy: `admin:${buyer.id}` });

    await expect(repo().history(a.id)).resolves.toMatchObject([{ status: 'confirmed' }]);
    await expect(repo().history(b.id)).resolves.toMatchObject([{ status: 'cancelled' }]);
  });

  it('goes with the order when the order is deleted (ON DELETE CASCADE)', async () => {
    const order = await anOrder().withStatus('pending').create(ctx.db());
    await transition(ctx.db(), { orderId: order.id, to: 'confirmed', changedBy: 'fulfilment' });

    await repo().delete(order.id);

    await expect(repo().history(order.id)).resolves.toEqual([]);
  });
});

// Two transactions out of the same status, on two real connections. The rollback
// context runs on one connection and cannot race itself, so these rows are
// committed and removed afterwards.
describe('two concurrent transitions out of one status', () => {
  const pool = testPool();
  const created: { orderId: string; buyerId: string }[] = [];

  afterAll(async () => {
    for (const { orderId, buyerId } of created) {
      await pool.query(`DELETE FROM outbox WHERE aggregate_type = 'order' AND aggregate_id = $1`, [orderId]);
      await pool.query(`DELETE FROM orders WHERE id = $1`, [orderId]);
      await pool.query(`DELETE FROM users WHERE id = $1`, [buyerId]);
    }
    await pool.end();
  });

  it('lets exactly one of them win; the loser sees the winner\'s status', async () => {
    const setup = await pool.connect();
    let orderId: string;
    try {
      const buyer = await aUser().create(setup);
      orderId = (await anOrder().placedBy(buyer).withStatus('pending').create(setup)).id;
      created.push({ orderId, buyerId: buyer.id });
    } finally {
      setup.release();
    }

    // paid and cancelled: neither is reachable from the other, so only one can happen
    const attempt = async (to: 'paid' | 'cancelled') => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await transition(client, { orderId, to, changedBy: to === 'paid' ? 'payment-webhook' : 'admin:1' });
        // hold the row lock long enough for the other side to queue behind it
        await client.query('SELECT pg_sleep(0.2)');
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };

    const results = await Promise.all([attempt('paid'), attempt('cancelled')]);

    const winners = results.filter((r) => r.kind === 'changed');
    const losers = results.filter((r) => r.kind === 'refused');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM orders WHERE id = $1`, [orderId]);
    const final = rows[0].status;
    expect(losers[0]).toEqual({ kind: 'refused', current: final });

    const history = await new OrdersRepository(pool).history(orderId);
    expect(history.map((h) => h.status)).toEqual([final]);
    const outbox = await pool.query(`SELECT 1 FROM outbox WHERE aggregate_type = 'order' AND aggregate_id = $1`, [orderId]);
    expect(outbox.rowCount).toBe(1);
  });
});

// The consumer and the payment webhook on one order, as they really meet: each
// first inserts a row with a foreign key to the order (order_fulfilments,
// payment_events), which takes FOR KEY SHARE on the order row, and only then
// moves the status. A transition that locked the row FOR UPDATE conflicted with
// the other side's KEY SHARE, so each waited for the other: 40P01, a 500 to the
// provider. A status change is not a key change — FOR NO KEY UPDATE is enough.
describe('the consumer and the webhook on one order at once', () => {
  const pool = testPool();
  const created: { orderId: string; buyerId: string }[] = [];

  afterAll(async () => {
    for (const { orderId, buyerId } of created) {
      await pool.query(`DELETE FROM outbox WHERE aggregate_type = 'order' AND aggregate_id = $1`, [orderId]);
      await pool.query(`DELETE FROM orders WHERE id = $1`, [orderId]);
      await pool.query(`DELETE FROM users WHERE id = $1`, [buyerId]);
    }
    await pool.end();
  });

  it('does not deadlock when both already hold the foreign-key lock', async () => {
    const setup = await pool.connect();
    let orderId: string;
    try {
      const buyer = await aUser().create(setup);
      orderId = (await anOrder().placedBy(buyer).withStatus('pending').create(setup)).id;
      created.push({ orderId, buyerId: buyer.id });
    } finally {
      setup.release();
    }

    // both sides take their KEY SHARE before either tries to move the status
    let arrived = 0;
    let release!: () => void;
    const bothHoldKeyShare = new Promise<void>((resolve) => (release = resolve));

    const side = async (to: 'confirmed' | 'paid', changedBy: string) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT 1 FROM orders WHERE id = $1 FOR KEY SHARE`, [orderId]);
        if (++arrived === 2) release();
        await bothHoldKeyShare;
        const result = await transition(client, { orderId, to, changedBy });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };

    const results = await Promise.all([
      side('confirmed', 'fulfilment'),
      side('paid', 'payment-webhook'),
    ]);

    // whichever ran first, the order ends up paid and nobody got 40P01
    expect(results.some((r) => r.kind === 'changed')).toBe(true);
    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM orders WHERE id = $1`, [orderId]);
    expect(rows[0].status).toBe('paid');
  });
});
