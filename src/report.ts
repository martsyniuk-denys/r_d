import 'reflect-metadata';

import { AppDataSource } from './data-source';
import { OrderItem } from './entities';

interface Row {
  seller_id: string;
  seller_name: string;
  country: string;
  orders: string;
  units: string;
  revenue_minor: string;
}

const REVENUE = 'SUM(item.qty * item.unitPriceMinor)';

const money = (minor: number): string =>
  (minor / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

async function main(): Promise<void> {
  const dataSource = await AppDataSource.initialize();

  try {
    const qb = dataSource
      .getRepository(OrderItem)
      .createQueryBuilder('item')
      .innerJoin('item.order', 'order')
      .innerJoin('item.product', 'product')
      .innerJoin('product.seller', 'seller')
      .select('seller.id', 'seller_id')
      .addSelect('seller.displayName', 'seller_name')
      .addSelect('seller.country', 'country')
      .addSelect('COUNT(DISTINCT order.id)', 'orders')
      .addSelect('SUM(item.qty)', 'units')
      .addSelect(REVENUE, 'revenue_minor')
      .where('order.status IN (:...statuses)', { statuses: ['paid', 'shipped'] })
      .groupBy('seller.id')
      .addGroupBy('seller.displayName')
      .addGroupBy('seller.country')
      .orderBy(REVENUE, 'DESC')
      .addOrderBy('seller.id', 'ASC');

    const rows = await qb.getRawMany<Row>();

    console.log('Revenue by seller — settled orders only (paid, shipped)\n');
    console.log(qb.getSql());
    console.log('');

    const header = `${'seller'.padEnd(18)} ${'cc'.padEnd(2)} ${'orders'.padStart(6)} ${'units'.padStart(5)} ${'revenue, UAH'.padStart(14)}`;
    console.log(header);
    console.log('-'.repeat(header.length));

    let revenueTotal = 0;
    let unitsTotal = 0;

    for (const row of rows) {
      const revenue = Number(row.revenue_minor);
      const units = Number(row.units);
      revenueTotal += revenue;
      unitsTotal += units;

      console.log(
        `${row.seller_name.padEnd(18)} ${row.country.padEnd(2)} ` +
          `${row.orders.padStart(6)} ${String(units).padStart(5)} ${money(revenue).padStart(14)}`,
      );
    }

    console.log('-'.repeat(header.length));
    console.log(
      `${'total'.padEnd(18)} ${''.padEnd(2)} ${''.padStart(6)} ` +
        `${String(unitsTotal).padStart(5)} ${money(revenueTotal).padStart(14)}`,
    );
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
