import { OrdersRepository } from '../../src/repositories';
import { aProduct, aUser, anOrder } from '../testkit/builders';
import { withRollback } from '../testkit/rollback';

describe('OrdersRepository against a real Postgres', () => {
  const ctx = withRollback();
  const repo = (): OrdersRepository => new OrdersRepository(ctx.db());

  it('reads an order back with its lines joined to the catalogue', async () => {
    const seller = await aUser().create(ctx.db());
    const buyer = await aUser().create(ctx.db());
    const keyboard = await aProduct()
      .soldBy(seller)
      .named('Mechanical keyboard')
      .pricedAt(260_000)
      .create(ctx.db());
    const mouse = await aProduct()
      .soldBy(seller)
      .named('Wireless mouse')
      .pricedAt(89_900)
      .create(ctx.db());

    const order = await anOrder()
      .placedBy(buyer)
      .withLine(keyboard, 2)
      .withLine(mouse, 1)
      .create(ctx.db());

    const found = await repo().findWithLines(order.id);

    expect(found?.buyerId).toBe(buyer.id);
    expect(found?.totalMinor).toBe(260_000 * 2 + 89_900);
    // the product name is never copied into order_items — only the JOIN knows it
    expect(found?.lines).toEqual([
      { productId: keyboard.id, productName: 'Mechanical keyboard', qty: 2, unitPriceMinor: 260_000 },
      { productId: mouse.id, productName: 'Wireless mouse', qty: 1, unitPriceMinor: 89_900 },
    ]);
  });

  it('refuses the same product twice in one order — unique violation 23505', async () => {
    const product = await aProduct().create(ctx.db());
    const order = await anOrder().withLine(product, 1).create(ctx.db());

    await ctx.attempt(async () => {
      await expect(
        repo().addLine({
          orderId: order.id,
          productId: product.id,
          qty: 5,
          unitPriceMinor: product.priceMinor,
        }),
      ).rejects.toMatchObject({
        code: '23505',
        constraint: 'order_items_order_product_unique',
      });
    });

    await expect(repo().countLines(order.id)).resolves.toBe(1);
  });

  it('sums revenue per seller and leaves unpaid orders out of it', async () => {
    // one connection, one transaction: these go one after another on purpose
    const alice = await aUser().withCountry('UA').create(ctx.db());
    const bob = await aUser().withCountry('PL').create(ctx.db());
    const buyer = await aUser().create(ctx.db());

    const fromAlice = await aProduct().soldBy(alice).pricedAt(10_000).create(ctx.db());
    const fromBob = await aProduct().soldBy(bob).pricedAt(3_000).create(ctx.db());

    await anOrder().placedBy(buyer).withStatus('paid').withLine(fromAlice, 3).create(ctx.db());
    await anOrder().placedBy(buyer).withStatus('shipped').withLine(fromBob, 2).create(ctx.db());
    await anOrder().placedBy(buyer).withStatus('cancelled').withLine(fromAlice, 9).create(ctx.db());

    const revenue = await repo().revenueBySeller();

    expect(revenue).toEqual([
      { sellerId: alice.id, displayName: alice.displayName, orders: 1, itemsSold: 3, revenueMinor: 30_000 },
      { sellerId: bob.id, displayName: bob.displayName, orders: 1, itemsSold: 2, revenueMinor: 6_000 },
    ]);
  });

  it('takes the order lines with it when the order is deleted (ON DELETE CASCADE)', async () => {
    const product = await aProduct().create(ctx.db());
    const order = await anOrder().withLine(product, 4).create(ctx.db());

    await expect(repo().countLines(order.id)).resolves.toBe(1);

    const deleted = await repo().delete(order.id);

    expect(deleted).toBe(1);
    await expect(repo().findById(order.id)).resolves.toBeNull();
    await expect(repo().countLines(order.id)).resolves.toBe(0);
  });
});
