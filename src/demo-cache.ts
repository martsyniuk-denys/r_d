import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { Server } from 'node:http';

import express, { Request, Response } from 'express';
import { DataSource } from 'typeorm';

import { CacheAside, ReadSource, lockKey, releaseLock } from './cache/cache-aside';
import { ProductCards, cardKey } from './cache/product-cards';
import { Invariants, pause, report, runDemo } from './common/demo-output';
import { dataSourceOptions } from './data-source';
import { listen } from './orders/checkout.http';
import { connectRedis, memoryPolicy } from './redis/connection';
import { CountingQueryable, ProductCardsRepository, fromDataSource } from './repositories';

// Cache-aside on the product card, and the stampede it would cause without a lock.
//
//   1. warm   60 cards, each a miss → one query → SET with TTL 300 + random(0..60)
//   2. burst  one key expires; 50 concurrent GETs for it → one query
//   3. warm   100 more reads of warmed cards → no query at all
//   4. control the same burst with the lock switched off → one query per request
//   5. a lapsed lock holder cannot release the lock somebody else took since
//
// Database calls are counted under the repository, by the Queryable every query
// goes through — the number of statements sent to Postgres.

const SELLER_EMAIL = 'cache-demo@marketplace.test';
const PRODUCTS = 60;
const CONCURRENT = 50;
const WARM_READS = 100;
const LOAD_DELAY_MS = 150;

async function fixtures(dataSource: DataSource): Promise<string[]> {
  const [{ id: sellerId }]: { id: string }[] = await dataSource.query(
    `INSERT INTO users (email, display_name, country)
     VALUES ($1, 'Cache demo seller', 'UA')
     ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
    [SELLER_EMAIL],
  );
  await dataSource.query(
    `INSERT INTO products (seller_id, name, price_minor, stock, currency, status)
     SELECT $1, 'Cache demo item ' || n, 1000 + n, 50, 'UAH', 'active'
       FROM generate_series(1, $2::int) AS n
      WHERE NOT EXISTS (
            SELECT 1 FROM products WHERE seller_id = $1 AND name = 'Cache demo item ' || n)`,
    [sellerId, PRODUCTS],
  );
  const rows: { id: string }[] = await dataSource.query(
    `SELECT id FROM products WHERE seller_id = $1 AND name LIKE 'Cache demo item %' ORDER BY id LIMIT $2`,
    [sellerId, PRODUCTS],
  );
  return rows.map((row) => row.id);
}

function cardApp(withLock: ProductCards, withoutLock: ProductCards): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.get('/products/:id/card', async (req: Request, res: Response) => {
    const cards = req.query['single-flight'] === 'off' ? withoutLock : withLock;
    try {
      const { value, source } = await cards.get(req.params.id);
      if (value === null) return res.status(404).json({ source });
      res.setHeader('X-Cache', source);
      return res.json(value);
    } catch (error) {
      return res.status(500).json({ detail: error instanceof Error ? error.message : String(error) });
    }
  });
  return app;
}

async function read(url: string, id: string, query = ''): Promise<ReadSource> {
  const response = await fetch(`${url}/products/${id}/card${query}`);
  if (response.status !== 200) throw new Error(`GET card ${id}: ${response.status}`);
  await response.arrayBuffer();
  return response.headers.get('x-cache') as ReadSource;
}

const tally = (sources: ReadSource[]): string =>
  Object.entries(
    sources.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {}),
  )
    .map(([source, count]) => `${source} ${count}`)
    .join(', ');

runDemo(async () => {
  const invariants = new Invariants();
  const dataSource = new DataSource({ ...dataSourceOptions, logging: ['error'] });
  await dataSource.initialize();
  await dataSource.runMigrations({ transaction: 'each' });

  const redis = connectRedis('cache', 'demo-cache');
  let server: Server | undefined;
  const ids = await fixtures(dataSource);
  const keys = ids.map(cardKey);
  const cleanup = async (): Promise<void> => {
    await redis.del(...keys, ...keys.map(lockKey));
  };

  try {
    await cleanup();

    const { policy, maxmemory } = await memoryPolicy(redis);
    console.log(`cache instance: maxmemory-policy ${policy}, maxmemory ${maxmemory} bytes`);

    const db = new CountingQueryable(fromDataSource(dataSource));
    const repository = new ProductCardsRepository(db);
    const withLock = new ProductCards(repository, new CacheAside(redis), LOAD_DELAY_MS);
    const withoutLock = new ProductCards(repository, new CacheAside(redis, { singleFlight: false }), LOAD_DELAY_MS);
    const listening = await listen(cardApp(withLock, withoutLock));
    server = listening.server;
    const { url } = listening;

    // 1. warm
    db.reset();
    await Promise.all(ids.map((id) => read(url, id)));
    const dbCallsCold = db.calls;
    const ttls = (await redis.pipeline(keys.map((key) => ['ttl', key])).exec())!.map(([, ttl]) => Number(ttl));
    const warmed = ttls.filter((ttl) => ttl > 0).length;
    const ttlDistinct = new Set(ttls.filter((ttl) => ttl > 0)).size;
    console.log(
      `\n1. warmed ${warmed} cards with ${dbCallsCold} queries; TTLs ${Math.min(...ttls)}..${Math.max(...ttls)} s, ` +
        `${ttlDistinct} distinct values`,
    );

    // 2. the stampede: a key that has just expired, and a crowd behind it
    const hot = ids[0];
    await redis.pexpire(cardKey(hot), 1);
    await pause(20);
    const gone = (await redis.exists(cardKey(hot))) === 0;
    db.reset();
    const burst = await Promise.all(Array.from({ length: CONCURRENT }, () => read(url, hot)));
    const dbCalls = db.calls;
    console.log(`2. key expired (${gone ? 'gone' : 'still there'}); ${CONCURRENT} concurrent reads → ${dbCalls} query (${tally(burst)})`);

    // 3. warm reads
    db.reset();
    const warmSources: ReadSource[] = [];
    for (let i = 0; i < WARM_READS; i += 1) warmSources.push(await read(url, ids[i % ids.length]));
    const dbCallsWarm = db.calls;
    console.log(`3. ${WARM_READS} reads of warm cards → ${dbCallsWarm} queries (${tally(warmSources)})`);

    // 4. control: the same burst without the lock
    await redis.del(cardKey(hot));
    db.reset();
    await Promise.all(Array.from({ length: CONCURRENT }, () => read(url, hot, '?single-flight=off')));
    const dbCallsWithoutLock = db.calls;
    console.log(`4. control, lock off: ${CONCURRENT} concurrent reads → ${dbCallsWithoutLock} queries`);

    // 5. a holder whose lock lapsed comes back and releases "its" lock
    const lock = lockKey(`card:product:demo-${randomUUID()}`);
    const tokenA = randomUUID();
    const tokenB = randomUUID();
    await redis.set(lock, tokenA, 'PX', 50, 'NX');
    await pause(100);
    const takenByB = (await redis.set(lock, tokenB, 'PX', 5000, 'NX')) === 'OK';
    const releasedByA = await releaseLock(redis, lock, tokenA);
    const foreignLockKept = (await redis.get(lock)) === tokenB;
    await releaseLock(redis, lock, tokenB);
    console.log(
      `5. A's lock lapsed, B took it (${takenByB}); A's compare-and-delete removed ${releasedByA ? 1 : 0} key; ` +
        `B still holds it: ${foreignLockKept}\n`,
    );

    invariants.check('cache is an evicting instance', policy !== 'noeviction', policy);
    invariants.check('cache has a memory bound', maxmemory > 0, `${maxmemory} bytes`);
    invariants.check('every card warmed', warmed === ids.length, `${warmed} of ${ids.length}`);
    invariants.check('TTL carries jitter', ttlDistinct >= 5, `${ttlDistinct} distinct TTLs`);
    invariants.check('stampede → one query', dbCalls === 1, `${dbCalls}`);
    invariants.check('warm reads → no query', dbCallsWarm === 0, `${dbCallsWarm}`);
    invariants.check('a lapsed holder cannot unlock', !releasedByA && foreignLockKept, `${foreignLockKept}`);
    console.log('');

    report({
      'cache-lru': policy !== 'noeviction' ? 1 : 0,
      'cache-maxmemory': maxmemory > 0 ? 1 : 0,
      warmed,
      'ttl-distinct': ttlDistinct,
      'db-calls-cold': dbCallsCold,
      concurrent: CONCURRENT,
      'db-calls': dbCalls,
      'db-calls-warm': dbCallsWarm,
      'db-calls-without-lock': dbCallsWithoutLock,
      'foreign-lock-kept': foreignLockKept ? 1 : 0,
    });

    return invariants.broken === 0 ? 0 : 1;
  } finally {
    await cleanup();
    server?.close();
    await redis.quit();
    await dataSource.destroy();
  }
});
