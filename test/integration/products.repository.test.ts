import { ProductsRepository } from '../../src/repositories';
import { aProduct, aUser } from '../testkit/builders';
import { withRollback } from '../testkit/rollback';

describe('ProductsRepository against a real Postgres', () => {
  const ctx = withRollback();
  const repo = (): ProductsRepository => new ProductsRepository(ctx.db());

  it('round-trips a product and keeps the price an integer number of minor units', async () => {
    const seller = await aUser().create(ctx.db());

    const created = await repo().insert(
      aProduct().soldBy(seller).named('Ergonomic keyboard').pricedAt(260_000).build(),
    );
    const found = await repo().findById(created.id);

    expect(found).not.toBeNull();
    expect(found?.priceMinor).toBe(260_000);
    expect(typeof found?.priceMinor).toBe('number');
    expect(found?.sellerId).toBe(seller.id);
    expect(found?.createdAt).toBeInstanceOf(Date);
  });

  it('refuses a product whose seller does not exist — foreign key 23503', async () => {
    await ctx.attempt(async () => {
      await expect(
        repo().insert(aProduct().soldBy('987654321').named('Orphan').build()),
      ).rejects.toMatchObject({
        code: '23503',
        constraint: expect.stringContaining('FK_'),
      });
    });

    // the transaction is usable again, which is what the savepoint is for
    await expect(repo().findById('987654321')).resolves.toBeNull();
  });

  it('matches whole words through the generated search_vector, in any order', async () => {
    const seller = await aUser().create(ctx.db());
    const target = await aProduct()
      .soldBy(seller)
      .named('Ноутбук Vela 14', 'легкий алюмінієвий корпус')
      .create(ctx.db());
    await aProduct().soldBy(seller).named('Килимок для миші').create(ctx.db());

    const byName = await repo().search('ноутбук');
    const byDescription = await repo().search('алюмінієвий корпус');
    const bySubstring = await repo().search('ноут');

    expect(byName.map((p) => p.id)).toEqual([target.id]);
    expect(byDescription.map((p) => p.id)).toEqual([target.id]);
    // a tsvector indexes words, not substrings — a LIKE '%ноут%' would have matched
    expect(bySubstring).toEqual([]);
  });

  it('pages in a stable order and does not repeat a row across pages', async () => {
    const seller = await aUser().create(ctx.db());
    for (const name of ['first', 'second', 'third']) {
      await aProduct().soldBy(seller).named(name).create(ctx.db());
    }

    const firstPage = await repo().page(2, 0);
    const secondPage = await repo().page(2, 2);

    expect(firstPage).toHaveLength(2);
    expect(secondPage).toHaveLength(1);
    expect(firstPage.map((p) => p.name)).toEqual(['first', 'second']);
    expect(secondPage.map((p) => p.name)).toEqual(['third']);
  });
});
