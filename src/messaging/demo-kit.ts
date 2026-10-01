import { ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { Channel, ChannelModel } from 'amqplib';
import { DataSource } from 'typeorm';

import { dataSourceOptions } from '../data-source';
import { connectBroker } from './broker';
import { EventPublisher } from './publisher';
import { ConsumerEvent } from './order-placed.consumer';
import { FULFILMENT_DLQ, FULFILMENT_QUEUE, declareTopology } from './topology';

// What the three broker demos share: a clean slate, a consumer in a child process
// whose stdout is read line by line, queue depths, and the key=value report.

const DEMO_BUYER_EMAIL = 'broker-demo@marketplace.test';
const DEMO_PRODUCT_NAME = 'Broker demo item';
const DEMO_BALANCE_MINOR = 10_000_000;
const DEMO_STOCK = 100;
const DEMO_PRICE_MINOR = 1_250;

export interface DemoContext {
  dataSource: DataSource;
  connection: ChannelModel;
  channel: Channel;
  publisher: EventPublisher;
  buyerId: string;
  productId: string;
}

export async function openDemo(name: string): Promise<DemoContext> {
  const dataSource = new DataSource({ ...dataSourceOptions, logging: ['error'] });
  await dataSource.initialize();
  // A fresh clone has no order_fulfilments table yet; bringing the schema up to
  // date is part of putting the state where the demo expects it.
  await dataSource.runMigrations({ transaction: 'each' });

  const connection = await connectBroker(name);
  const channel = await connection.createChannel();

  // The bootstrap step: the same declaration the consumer makes on start. It runs
  // here first so the queues exist to be purged before any consumer attaches.
  await declareTopology(channel);
  await channel.purgeQueue(FULFILMENT_QUEUE);
  await channel.purgeQueue(FULFILMENT_DLQ);

  const { buyerId, productId } = await resetFixtures(dataSource);
  const publisher = await EventPublisher.open(connection);

  return { dataSource, connection, channel, publisher, buyerId, productId };
}

export async function closeDemo(context: DemoContext): Promise<void> {
  await context.publisher.close();
  await context.channel.close();
  await context.connection.close();
  await context.dataSource.destroy();
}

// The demo owns one buyer and one product and nothing else: their earlier orders
// go (and with them, by cascade, the fulfilments), stock and balance are reset.
async function resetFixtures(
  dataSource: DataSource,
): Promise<{ buyerId: string; productId: string }> {
  const [{ id: buyerId }]: { id: string }[] = await dataSource.query(
    `INSERT INTO users (email, display_name, country, balance_minor)
     VALUES ($1, 'Broker demo buyer', 'UA', $2)
     ON CONFLICT (email) DO UPDATE SET balance_minor = EXCLUDED.balance_minor
     RETURNING id`,
    [DEMO_BUYER_EMAIL, DEMO_BALANCE_MINOR],
  );

  await dataSource.query(`DELETE FROM orders WHERE buyer_id = $1`, [buyerId]);

  const existing: { id: string }[] = await dataSource.query(
    `SELECT id FROM products WHERE seller_id = $1 AND name = $2 ORDER BY id LIMIT 1`,
    [buyerId, DEMO_PRODUCT_NAME],
  );
  const productId =
    existing[0]?.id ??
    (
      (await dataSource.query(
        `INSERT INTO products (seller_id, name, price_minor, stock, currency, status)
         VALUES ($1, $2, $3, 0, 'UAH', 'active')
         RETURNING id`,
        [buyerId, DEMO_PRODUCT_NAME, DEMO_PRICE_MINOR],
      )) as { id: string }[]
    )[0].id;

  await dataSource.query(
    `UPDATE products SET stock = $2, price_minor = $3, status = 'active' WHERE id = $1`,
    [productId, DEMO_STOCK, DEMO_PRICE_MINOR],
  );

  return { buyerId, productId };
}

export async function fulfilmentsFor(dataSource: DataSource, orderIds: string[]): Promise<number> {
  const [{ count }]: { count: string }[] = await dataSource.query(
    `SELECT count(*) AS count FROM order_fulfilments WHERE order_id = ANY($1::bigint[])`,
    [orderIds],
  );
  return Number(count);
}

export async function depth(channel: Channel, queue: string): Promise<number> {
  return (await channel.checkQueue(queue)).messageCount;
}

// Queue counters lag the operation that changed them by a moment (a dead-letter
// hop, a requeue): poll until the expected value shows up, then report whatever
// is there — the caller's check decides whether it was right.
export async function settledDepth(
  channel: Channel,
  queue: string,
  expected: number,
  timeoutMs = 5000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let current = await depth(channel, queue);
  while (current !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    current = await depth(channel, queue);
  }
  return current;
}

type Observed = ConsumerEvent | { kind: 'holding'; eventId: string };

const children = new Set<ChildProcess>();
// A demo that dies half-way must not leave a consumer behind to eat the next
// run's messages.
process.on('exit', () => {
  for (const child of children) child.kill('SIGKILL');
});

export class ConsumerProcess {
  readonly events: Observed[] = [];
  private readonly waiters: (() => void)[] = [];
  private readonly exited: Promise<NodeJS.Signals | number | null>;

  private constructor(readonly child: ChildProcess) {
    createInterface({ input: child.stdout! }).on('line', (line) => {
      try {
        this.events.push(JSON.parse(line) as Observed);
      } catch {
        return;
      }
      for (const wake of this.waiters.splice(0)) wake();
    });
    this.exited = new Promise((resolve) => {
      child.on('exit', (code, signal) => {
        resolve(signal ?? code);
        for (const wake of this.waiters.splice(0)) wake();
      });
    });
  }

  static async start(...args: string[]): Promise<ConsumerProcess> {
    const child = spawn(process.execPath, [join(__dirname, '..', 'consumer.js'), ...args], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    children.add(child);
    child.on('exit', () => children.delete(child));
    const consumer = new ConsumerProcess(child);
    await consumer.waitFor((events) => events.some((e) => e.kind === 'ready'), 15_000, 'ready');
    return consumer;
  }

  get pid(): number {
    return this.child.pid ?? -1;
  }

  get prefetch(): number {
    const ready = this.events.find((e) => e.kind === 'ready');
    return ready?.kind === 'ready' ? ready.prefetch : 0;
  }

  count(predicate: (event: Observed) => boolean): number {
    return this.events.filter(predicate).length;
  }

  async waitFor(
    condition: (events: Observed[]) => boolean,
    timeoutMs: number,
    what: string,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition(this.events)) {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        throw new Error(`consumer ${this.pid} exited while waiting for: ${what}`);
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  // Graceful: basic.cancel, in-flight deliveries settle, connection closed.
  async stop(): Promise<NodeJS.Signals | number | null> {
    this.child.kill('SIGTERM');
    return this.exited;
  }

  // kill -9: no handler runs, the OS closes the socket, the broker sees a dead
  // connection and puts every unacked delivery back.
  async crash(): Promise<NodeJS.Signals | number | null> {
    this.child.kill('SIGKILL');
    return this.exited;
  }
}

export class Invariants {
  private readonly failures: string[] = [];

  check(label: string, ok: boolean, detail: string): void {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}: ${detail}`);
    if (!ok) this.failures.push(label);
  }

  get broken(): number {
    return this.failures.length;
  }
}

export function report(values: Record<string, number | string>): void {
  for (const [key, value] of Object.entries(values)) console.log(`${key}=${value}`);
}

export function runDemo(main: () => Promise<number>): void {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
