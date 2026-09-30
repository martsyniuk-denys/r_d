import {
  NewProduct,
  NewUser,
  OrderStatus,
  OrdersRepository,
  ProductRecord,
  ProductsRepository,
  Queryable,
  UserRecord,
  UsersRepository,
} from '../../src/repositories';

// Every default is valid and unique, so a test names only what it is about.
let counter = 0;
const unique = (): string => `${Date.now().toString(36)}${(++counter).toString(36)}`;

export class UserBuilder {
  private data: NewUser = {
    email: `buyer-${unique()}@example.test`,
    displayName: `Buyer ${unique()}`,
    country: 'UA',
    balanceMinor: 1_000_000,
  };

  withEmail(email: string): this {
    this.data = { ...this.data, email };
    return this;
  }

  withCountry(country: string): this {
    this.data = { ...this.data, country };
    return this;
  }

  withBalance(balanceMinor: number): this {
    this.data = { ...this.data, balanceMinor };
    return this;
  }

  build(): NewUser {
    return { ...this.data };
  }

  create(db: Queryable): Promise<UserRecord> {
    return new UsersRepository(db).insert(this.build());
  }
}

export class ProductBuilder {
  private sellerId?: string;
  private data: Omit<NewProduct, 'sellerId'> = {
    name: `Product ${unique()}`,
    description: '',
    priceMinor: 12_900,
    currency: 'UAH',
    status: 'active',
    stock: 10,
  };

  soldBy(seller: UserRecord | string): this {
    this.sellerId = typeof seller === 'string' ? seller : seller.id;
    return this;
  }

  named(name: string, description = ''): this {
    this.data = { ...this.data, name, description };
    return this;
  }

  pricedAt(priceMinor: number): this {
    this.data = { ...this.data, priceMinor };
    return this;
  }

  withStatus(status: NewProduct['status']): this {
    this.data = { ...this.data, status };
    return this;
  }

  build(sellerId?: string): NewProduct {
    const id = sellerId ?? this.sellerId;
    if (id === undefined) throw new Error('ProductBuilder needs soldBy(seller)');
    return { ...this.data, sellerId: id };
  }

  async create(db: Queryable): Promise<ProductRecord> {
    const seller = this.sellerId ?? (await aUser().create(db)).id;
    return new ProductsRepository(db).insert(this.build(seller));
  }
}

export class OrderBuilder {
  private buyerId?: string;
  private status: OrderStatus = 'paid';
  private lines: { productId: string; qty: number; unitPriceMinor: number }[] = [];

  placedBy(buyer: UserRecord | string): this {
    this.buyerId = typeof buyer === 'string' ? buyer : buyer.id;
    return this;
  }

  withStatus(status: OrderStatus): this {
    this.status = status;
    return this;
  }

  withLine(product: ProductRecord | string, qty = 1, unitPriceMinor?: number): this {
    const productId = typeof product === 'string' ? product : product.id;
    const price =
      unitPriceMinor ?? (typeof product === 'string' ? 12_900 : product.priceMinor);
    this.lines = [...this.lines, { productId, qty, unitPriceMinor: price }];
    return this;
  }

  async create(db: Queryable): Promise<{ id: string; totalMinor: number }> {
    const buyerId = this.buyerId ?? (await aUser().create(db)).id;
    const totalMinor = this.lines.reduce((sum, l) => sum + l.qty * l.unitPriceMinor, 0);

    const orders = new OrdersRepository(db);
    const order = await orders.insert({
      buyerId,
      status: this.status,
      totalMinor,
      currency: 'UAH',
    });

    for (const line of this.lines) {
      await orders.addLine({ orderId: order.id, ...line });
    }

    return { id: order.id, totalMinor };
  }
}

export const aUser = (): UserBuilder => new UserBuilder();
export const aProduct = (): ProductBuilder => new ProductBuilder();
export const anOrder = (): OrderBuilder => new OrderBuilder();
