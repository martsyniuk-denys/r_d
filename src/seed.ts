import 'reflect-metadata';

import { EntityManager } from 'typeorm';

import { AppDataSource } from './data-source';
import { Currency, Order, OrderItem, OrderStatus, Product, ProductStatus, User } from './entities';

interface UserFixture {
  email: string;
  displayName: string;
  country: string;
  createdAt: string;
}

interface ProductFixture {
  sellerEmail: string;
  name: string;
  description: string;
  priceMinor: number;
  currency: Currency;
  status: ProductStatus;
  createdAt: string;
}

interface OrderFixture {
  buyerEmail: string;
  status: OrderStatus;
  currency: Currency;
  createdAt: string;
  items: { productName: string; qty: number }[];
}

const USERS: UserFixture[] = [
  { email: 'leader.shoes@example.com', displayName: 'Лідер Взуття', country: 'UA', createdAt: '2025-01-10T08:00:00Z' },
  { email: 'comfort.shoes@example.com', displayName: 'Комфорт Шуз', country: 'UA', createdAt: '2025-01-11T08:00:00Z' },
  { email: 'style.market@example.com', displayName: 'Стиль Маркет', country: 'PL', createdAt: '2025-01-12T08:00:00Z' },
  { email: 'practic.sport@example.com', displayName: 'Практик Спорт', country: 'DE', createdAt: '2025-01-13T08:00:00Z' },
  { email: 'olena.kovalenko@example.com', displayName: 'Олена Коваленко', country: 'UA', createdAt: '2025-02-01T08:00:00Z' },
  { email: 'andrii.shevchenko@example.com', displayName: 'Андрій Шевченко', country: 'UA', createdAt: '2025-02-02T08:00:00Z' },
  { email: 'marta.bondarenko@example.com', displayName: 'Марта Бондаренко', country: 'PL', createdAt: '2025-02-03T08:00:00Z' },
  { email: 'yurii.tkachenko@example.com', displayName: 'Юрій Ткаченко', country: 'UA', createdAt: '2025-02-04T08:00:00Z' },
];

const PRODUCTS: ProductFixture[] = [
  {
    sellerEmail: 'leader.shoes@example.com',
    name: 'Кросівки шкіряні Лідер',
    description: 'Якісні кросівки шкіряні для щоденного використання. Матеріал: натуральна шкіра.',
    priceMinor: 249900,
    currency: 'UAH',
    status: 'active',
    createdAt: '2025-03-01T10:00:00Z',
  },
  {
    sellerEmail: 'leader.shoes@example.com',
    name: 'Черевики зимові Лідер',
    description: 'Теплі черевики зимові на хутрі. Матеріал: нубук.',
    priceMinor: 389900,
    currency: 'UAH',
    status: 'active',
    createdAt: '2025-03-02T10:00:00Z',
  },
  {
    sellerEmail: 'leader.shoes@example.com',
    name: 'Кеди літні Лідер',
    description: 'Легкі кеди літні з текстилю. Матеріал: текстиль.',
    priceMinor: 149900,
    currency: 'UAH',
    status: 'draft',
    createdAt: '2025-03-03T10:00:00Z',
  },
  {
    sellerEmail: 'comfort.shoes@example.com',
    name: 'Чоботи шкіряні Комфорт',
    description: 'Високі чоботи шкіряні на осінь. Матеріал: натуральна шкіра.',
    priceMinor: 429900,
    currency: 'UAH',
    status: 'active',
    createdAt: '2025-03-04T10:00:00Z',
  },
  {
    sellerEmail: 'comfort.shoes@example.com',
    name: 'Сандалі літні Комфорт',
    description: 'Відкриті сандалі літні з регулюванням. Матеріал: замша.',
    priceMinor: 119900,
    currency: 'UAH',
    status: 'active',
    createdAt: '2025-03-05T10:00:00Z',
  },
  {
    sellerEmail: 'comfort.shoes@example.com',
    name: 'Капці домашні Комфорт',
    description: "М'які капці домашні з закритим носком. Матеріал: текстиль.",
    priceMinor: 59900,
    currency: 'UAH',
    status: 'active',
    createdAt: '2025-03-06T10:00:00Z',
  },
  {
    sellerEmail: 'style.market@example.com',
    name: 'Окуляри сонцезахисні Стиль',
    description: 'Окуляри сонцезахисні з поляризацією. Матеріал: метал.',
    priceMinor: 89900,
    currency: 'UAH',
    status: 'active',
    createdAt: '2025-03-07T10:00:00Z',
  },
  {
    sellerEmail: 'style.market@example.com',
    name: 'Навушники бездротові Стиль',
    description: 'Навушники бездротові з активним шумозаглушенням.',
    priceMinor: 199900,
    currency: 'UAH',
    status: 'active',
    createdAt: '2025-03-08T10:00:00Z',
  },
  {
    sellerEmail: 'style.market@example.com',
    name: 'Джинси класичні Стиль',
    description: 'Джинси класичні прямого крою. Матеріал: денім.',
    priceMinor: 159900,
    currency: 'UAH',
    status: 'archived',
    createdAt: '2025-03-09T10:00:00Z',
  },
  {
    sellerEmail: 'practic.sport@example.com',
    name: 'Рукавички шкіряні Практик',
    description: 'Рукавички шкіряні з підкладкою. Матеріал: натуральна шкіра.',
    priceMinor: 79900,
    currency: 'UAH',
    status: 'active',
    createdAt: '2025-03-10T10:00:00Z',
  },
  {
    sellerEmail: 'practic.sport@example.com',
    name: 'Шкарпетки спортивні Практик',
    description: 'Шкарпетки спортивні, набір з трьох пар. Матеріал: бавовна.',
    priceMinor: 19900,
    currency: 'UAH',
    status: 'active',
    createdAt: '2025-03-11T10:00:00Z',
  },
  {
    sellerEmail: 'practic.sport@example.com',
    name: 'Кросівки туристичні Практик',
    description: 'Кросівки туристичні з мембраною. Матеріал: сітка та нубук.',
    priceMinor: 299900,
    currency: 'UAH',
    status: 'active',
    createdAt: '2025-03-12T10:00:00Z',
  },
];

const ORDERS: OrderFixture[] = [
  {
    buyerEmail: 'olena.kovalenko@example.com',
    status: 'paid',
    currency: 'UAH',
    createdAt: '2026-01-05T09:15:00Z',
    items: [
      { productName: 'Кросівки шкіряні Лідер', qty: 1 },
      { productName: 'Шкарпетки спортивні Практик', qty: 3 },
    ],
  },
  {
    buyerEmail: 'olena.kovalenko@example.com',
    status: 'shipped',
    currency: 'UAH',
    createdAt: '2026-01-12T11:40:00Z',
    items: [
      { productName: 'Черевики зимові Лідер', qty: 1 },
      { productName: 'Рукавички шкіряні Практик', qty: 2 },
    ],
  },
  {
    buyerEmail: 'andrii.shevchenko@example.com',
    status: 'paid',
    currency: 'UAH',
    createdAt: '2026-01-18T14:05:00Z',
    items: [
      { productName: 'Навушники бездротові Стиль', qty: 1 },
      { productName: 'Окуляри сонцезахисні Стиль', qty: 1 },
      { productName: 'Шкарпетки спортивні Практик', qty: 2 },
    ],
  },
  {
    buyerEmail: 'andrii.shevchenko@example.com',
    status: 'pending',
    currency: 'UAH',
    createdAt: '2026-02-02T08:30:00Z',
    items: [{ productName: 'Кеди літні Лідер', qty: 2 }],
  },
  {
    buyerEmail: 'marta.bondarenko@example.com',
    status: 'paid',
    currency: 'UAH',
    createdAt: '2026-02-09T16:20:00Z',
    items: [
      { productName: 'Чоботи шкіряні Комфорт', qty: 1 },
      { productName: 'Капці домашні Комфорт', qty: 2 },
      { productName: 'Сандалі літні Комфорт', qty: 1 },
    ],
  },
  {
    buyerEmail: 'marta.bondarenko@example.com',
    status: 'refunded',
    currency: 'UAH',
    createdAt: '2026-02-14T19:00:00Z',
    items: [{ productName: 'Кросівки туристичні Практик', qty: 1 }],
  },
  {
    buyerEmail: 'yurii.tkachenko@example.com',
    status: 'paid',
    currency: 'UAH',
    createdAt: '2026-02-21T10:10:00Z',
    items: [
      { productName: 'Кросівки шкіряні Лідер', qty: 2 },
      { productName: 'Навушники бездротові Стиль', qty: 1 },
      { productName: 'Рукавички шкіряні Практик', qty: 1 },
      { productName: 'Шкарпетки спортивні Практик', qty: 4 },
    ],
  },
  {
    buyerEmail: 'yurii.tkachenko@example.com',
    status: 'cancelled',
    currency: 'UAH',
    createdAt: '2026-03-01T12:45:00Z',
    items: [{ productName: 'Джинси класичні Стиль', qty: 1 }],
  },
  {
    buyerEmail: 'olena.kovalenko@example.com',
    status: 'paid',
    currency: 'UAH',
    createdAt: '2026-03-07T13:25:00Z',
    items: [
      { productName: 'Сандалі літні Комфорт', qty: 2 },
      { productName: 'Окуляри сонцезахисні Стиль', qty: 1 },
    ],
  },
  {
    buyerEmail: 'andrii.shevchenko@example.com',
    status: 'shipped',
    currency: 'UAH',
    createdAt: '2026-03-15T17:55:00Z',
    items: [
      { productName: 'Кросівки туристичні Практик', qty: 1 },
      { productName: 'Черевики зимові Лідер', qty: 1 },
      { productName: 'Капці домашні Комфорт', qty: 1 },
    ],
  },
];

async function seedUsers(manager: EntityManager): Promise<Map<string, User>> {
  const repo = manager.getRepository(User);
  const byEmail = new Map<string, User>();

  for (const fixture of USERS) {
    const existing = await repo.findOne({ where: { email: fixture.email } });
    const user = existing ?? repo.create({ email: fixture.email });

    user.displayName = fixture.displayName;
    user.country = fixture.country;
    user.createdAt = new Date(fixture.createdAt);

    byEmail.set(fixture.email, await repo.save(user));
  }

  return byEmail;
}

async function seedProducts(
  manager: EntityManager,
  users: Map<string, User>,
): Promise<Map<string, Product>> {
  const repo = manager.getRepository(Product);
  const byName = new Map<string, Product>();

  for (const fixture of PRODUCTS) {
    const seller = users.get(fixture.sellerEmail);
    if (!seller) throw new Error(`fixture error: no seller ${fixture.sellerEmail}`);

    const existing = await repo.findOne({
      where: { sellerId: seller.id, name: fixture.name },
    });
    const product = existing ?? repo.create({ sellerId: seller.id, name: fixture.name });

    product.description = fixture.description;
    product.priceMinor = fixture.priceMinor;
    product.currency = fixture.currency;
    product.status = fixture.status;
    product.createdAt = new Date(fixture.createdAt);

    byName.set(fixture.name, await repo.save(product));
  }

  return byName;
}

async function seedOrders(
  manager: EntityManager,
  users: Map<string, User>,
  products: Map<string, Product>,
): Promise<void> {
  const orders = manager.getRepository(Order);
  const items = manager.getRepository(OrderItem);

  for (const fixture of ORDERS) {
    const buyer = users.get(fixture.buyerEmail);
    if (!buyer) throw new Error(`fixture error: no buyer ${fixture.buyerEmail}`);

    const createdAt = new Date(fixture.createdAt);
    const lines = fixture.items.map((line) => {
      const product = products.get(line.productName);
      if (!product) throw new Error(`fixture error: no product ${line.productName}`);
      return { product, qty: line.qty };
    });

    const existing = await orders.findOne({ where: { buyerId: buyer.id, createdAt } });
    const order = existing ?? orders.create({ buyerId: buyer.id, createdAt });

    order.status = fixture.status;
    order.currency = fixture.currency;
    order.totalMinor = lines.reduce((sum, line) => sum + line.qty * line.product.priceMinor, 0);

    const saved = await orders.save(order);

    for (const line of lines) {
      const existingItem = await items.findOne({
        where: { orderId: saved.id, productId: line.product.id },
      });
      const item =
        existingItem ?? items.create({ orderId: saved.id, productId: line.product.id });

      item.qty = line.qty;
      item.unitPriceMinor = line.product.priceMinor;

      await items.save(item);
    }
  }
}

async function main(): Promise<void> {
  const dataSource = await AppDataSource.initialize();

  try {
    await dataSource.transaction(async (manager) => {
      const users = await seedUsers(manager);
      const products = await seedProducts(manager, users);
      await seedOrders(manager, users, products);
    });

    const counts = await Promise.all(
      [User, Product, Order, OrderItem].map(async (entity) => ({
        table: dataSource.getMetadata(entity).tableName,
        rows: await dataSource.getRepository(entity).count(),
      })),
    );

    console.log('seed done — rows per table (the same numbers on every run):');
    for (const { table, rows } of counts) {
      console.log(`  ${table.padEnd(12, ' ')} ${String(rows).padStart(3, ' ')}`);
    }
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
