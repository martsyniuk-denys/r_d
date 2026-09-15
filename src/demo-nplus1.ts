import 'reflect-metadata';

import { Between, DataSource } from 'typeorm';

import { dataSourceOptions } from './data-source';
import { QueryCountLogger } from './db/query-count-logger';
import { Order, OrderItem, Product } from './entities';

interface Window {
  label: string;
  from: string;
  to: string;
}

const WINDOWS: Window[] = [
  { label: 'January + early February 2026', from: '2026-01-01T00:00:00Z', to: '2026-02-10T00:00:00Z' },
  { label: 'the whole first quarter of 2026', from: '2026-01-01T00:00:00Z', to: '2026-04-01T00:00:00Z' },
];

interface Loaded {
  orders: number;
  items: number;
  products: number;
}

function period(window: Window) {
  return Between(new Date(window.from), new Date(window.to));
}

async function naive(dataSource: DataSource, window: Window): Promise<Loaded> {
  const orders = await dataSource.getRepository(Order).find({
    where: { createdAt: period(window) },
    order: { id: 'ASC' },
  });

  let items = 0;
  const products = new Set<string>();

  for (const order of orders) {
    const lines = await dataSource.getRepository(OrderItem).find({
      where: { orderId: order.id },
      order: { id: 'ASC' },
    });
    items += lines.length;

    for (const line of lines) {
      const product = await dataSource.getRepository(Product).findOneBy({ id: line.productId });
      if (product) products.add(product.id);
    }
  }

  return { orders: orders.length, items, products: products.size };
}

async function withRelations(dataSource: DataSource, window: Window): Promise<Loaded> {
  const orders = await dataSource.getRepository(Order).find({
    where: { createdAt: period(window) },
    order: { id: 'ASC' },
    relations: { items: { product: true } },
  });

  return count(orders);
}

async function withQueryStrategy(dataSource: DataSource, window: Window): Promise<Loaded> {
  const orders = await dataSource.getRepository(Order).find({
    where: { createdAt: period(window) },
    order: { id: 'ASC' },
    relations: { items: { product: true } },
    relationLoadStrategy: 'query',
  });

  return count(orders);
}

function count(orders: Order[]): Loaded {
  const products = new Set<string>();
  let items = 0;

  for (const order of orders) {
    items += order.items.length;
    for (const item of order.items) products.add(item.product.id);
  }

  return { orders: orders.length, items, products: products.size };
}

const STRATEGIES: { label: string; run: (ds: DataSource, w: Window) => Promise<Loaded> }[] = [
  { label: "naive — find() per order, then find() per item", run: naive },
  { label: "relations: { items: { product: true } }", run: withRelations },
  { label: "the same relations + relationLoadStrategy: 'query'", run: withQueryStrategy },
];

async function main(): Promise<void> {
  const logger = new QueryCountLogger();
  const dataSource = new DataSource({ ...dataSourceOptions, logging: ['query'], logger });

  await dataSource.initialize();

  try {
    console.log('graph: order -> items -> product (two levels of relations)\n');

    for (const [index, window] of WINDOWS.entries()) {
      const printSql = index === 0;
      console.log(`collection: orders of ${window.label}`);

      for (const strategy of STRATEGIES) {
        logger.reset(printSql);
        const loaded = await strategy.run(dataSource, window);
        const queries = logger.count;
        logger.reset(false);

        if (printSql) console.log('');
        console.log(
          `  ${String(queries).padStart(3, ' ')} ${queries === 1 ? 'query ' : 'queries'}  ` +
            `${strategy.label.padEnd(52, ' ')}` +
            `[loaded ${loaded.orders} orders / ${loaded.items} items / ${loaded.products} products]`,
        );
        if (printSql) console.log('');
      }

      console.log('');
    }

    console.log(
      'The naive number grows with the collection — 1 + orders + items — while both\n' +
        'fixed strategies stay flat: one JOIN query, or a small constant for\n' +
        "relationLoadStrategy: 'query' (root query, one query per relation level, plus\n" +
        'the id map that stitches the one-to-many back together).',
    );
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
