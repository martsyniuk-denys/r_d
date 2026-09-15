import 'reflect-metadata';

import { DataSource } from 'typeorm';

import { CheckoutRejection, CheckoutResult, checkout } from './concurrency/checkout';
import { dataSourceOptions } from './data-source';
import { BUYER_BALANCE_MINOR } from './seed';

const ATTEMPTS = 50;
const START_STOCK = 10;
const QTY = 1;
const POOL_SIZE = 25;

interface Target {
  id: string;
  name: string;
  priceMinor: number;
}

interface Settled {
  buyerId: string;
  result?: CheckoutResult;
  error?: unknown;
}

async function prepare(dataSource: DataSource): Promise<{ target: Target; buyerIds: string[] }> {
  const products: { id: string; name: string; price_minor: number }[] = await dataSource.query(
    `SELECT id, name, price_minor FROM products WHERE status = 'active' ORDER BY id LIMIT 1`,
  );
  if (products.length === 0) throw new Error('no active products — run npm run seed first');

  const buyers: { id: string }[] = await dataSource.query(
    `SELECT DISTINCT buyer_id AS id FROM orders ORDER BY 1`,
  );
  if (buyers.length === 0) throw new Error('no buyers — run npm run seed first');

  const buyerIds = buyers.map((row) => row.id);

  await dataSource.query(`UPDATE products SET stock = $2 WHERE id = $1`, [
    products[0].id,
    START_STOCK,
  ]);
  await dataSource.query(`UPDATE users SET balance_minor = $2 WHERE id = ANY($1::bigint[])`, [
    buyerIds,
    BUYER_BALANCE_MINOR,
  ]);

  return {
    target: { id: products[0].id, name: products[0].name, priceMinor: products[0].price_minor },
    buyerIds,
  };
}

async function main(): Promise<void> {
  const dataSource = new DataSource({ ...dataSourceOptions, poolSize: POOL_SIZE });
  await dataSource.initialize();

  const failures: string[] = [];
  const check = (label: string, ok: boolean, detail: string): void => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}: ${detail}`);
    if (!ok) failures.push(label);
  };

  try {
    const { target, buyerIds } = await prepare(dataSource);

    console.log(
      `${ATTEMPTS} parallel checkouts of "${target.name}" — stock ${START_STOCK}, ` +
        `qty ${QTY} each, ${buyerIds.length} buyers with ${BUYER_BALANCE_MINOR} minor units on the balance\n`,
    );

    const startedAt = Date.now();
    const settled: Settled[] = await Promise.all(
      Array.from({ length: ATTEMPTS }, (_, index) => {
        const buyerId = buyerIds[index % buyerIds.length];
        return checkout(dataSource, { buyerId, productId: target.id, qty: QTY }).then(
          (result): Settled => ({ buyerId, result }),
          (error: unknown): Settled => ({ buyerId, error }),
        );
      }),
    );
    const elapsedMs = Date.now() - startedAt;

    const accepted = settled.filter((item) => item.result?.ok === true);
    const declined = new Map<CheckoutRejection, number>();
    const crashed: unknown[] = [];

    for (const item of settled) {
      if (item.error !== undefined) crashed.push(item.error);
      else if (item.result !== undefined && !item.result.ok) {
        declined.set(item.result.reason, (declined.get(item.result.reason) ?? 0) + 1);
      }
    }

    const orderIds = accepted.map((item) => (item.result as { orderId: string }).orderId);

    const [{ stock }]: { stock: number }[] = await dataSource.query(
      `SELECT stock FROM products WHERE id = $1`,
      [target.id],
    );
    const [{ negative }]: { negative: string }[] = await dataSource.query(
      `SELECT count(*) AS negative FROM products WHERE stock < 0`,
    );
    const [{ orders }]: { orders: string }[] = await dataSource.query(
      `SELECT count(*) AS orders FROM orders WHERE id = ANY($1::bigint[])`,
      [orderIds],
    );
    const [{ lines }]: { lines: string }[] = await dataSource.query(
      `SELECT count(*) AS lines FROM order_items WHERE order_id = ANY($1::bigint[])`,
      [orderIds],
    );
    const [{ jobs }]: { jobs: string }[] = await dataSource.query(
      `SELECT count(*) AS jobs FROM jobs WHERE order_id = ANY($1::bigint[])`,
      [orderIds],
    );
    const [{ orphans }]: { orphans: string }[] = await dataSource.query(
      `SELECT count(*) AS orphans
         FROM orders o
         LEFT JOIN order_items i ON i.order_id = o.id
        WHERE i.id IS NULL`,
    );

    const balances: { id: string; balance_minor: number }[] = await dataSource.query(
      `SELECT id, balance_minor FROM users WHERE id = ANY($1::bigint[]) ORDER BY id`,
      [buyerIds],
    );
    const spentPerBuyer = new Map<string, number>();
    for (const item of accepted) {
      spentPerBuyer.set(item.buyerId, (spentPerBuyer.get(item.buyerId) ?? 0) + target.priceMinor);
    }
    const balanceDrift = balances.filter(
      (row) =>
        Number(row.balance_minor) !==
        BUYER_BALANCE_MINOR - (spentPerBuyer.get(row.id) ?? 0),
    );

    console.log(`attempts                 ${ATTEMPTS}`);
    console.log(`successful checkouts     ${accepted.length}`);
    for (const [reason, times] of [...declined.entries()].sort()) {
      console.log(`declined: ${reason.padEnd(14, ' ')}${times}`);
    }
    console.log(`unexpected errors        ${crashed.length}`);
    console.log(`final stock              ${stock}`);
    console.log(`rows with negative stock ${negative}`);
    console.log(`wall clock               ${elapsedMs} ms\n`);

    if (crashed.length > 0) {
      console.log('first unexpected error:');
      console.log(`  ${crashed[0] instanceof Error ? crashed[0].message : String(crashed[0])}\n`);
    }

    console.log('invariants');
    check(
      'successes equal the initial stock',
      accepted.length === START_STOCK,
      `${accepted.length} === ${START_STOCK}`,
    );
    check('final stock is zero', Number(stock) === 0, `${stock}`);
    check('no row has negative stock', Number(negative) === 0, `${negative}`);
    check('no unexpected errors', crashed.length === 0, `${crashed.length}`);
    check(
      'every success wrote an order',
      Number(orders) === accepted.length,
      `${orders} === ${accepted.length}`,
    );
    check(
      'every order got its line',
      Number(lines) === accepted.length,
      `${lines} === ${accepted.length}`,
    );
    check(
      'every order queued a post-processing job',
      Number(jobs) === accepted.length,
      `${jobs} === ${accepted.length}`,
    );
    check('no orphan orders in the whole table', Number(orphans) === 0, `${orphans}`);
    check(
      'balances match successes exactly',
      balanceDrift.length === 0,
      balanceDrift.length === 0
        ? 'no lost update'
        : balanceDrift.map((row) => `${row.id}:${row.balance_minor}`).join(', '),
    );
  } finally {
    await dataSource.destroy();
  }

  if (failures.length > 0) {
    console.error(`\noversell or lost update detected — ${failures.length} broken invariant(s)`);
    process.exit(1);
  }

  console.log('\nno oversell: the atomic UPDATE let exactly stock checkouts through.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
