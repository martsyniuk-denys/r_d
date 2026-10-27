import { randomInt, randomUUID } from 'node:crypto';

import Redis from 'ioredis';

import { sleep } from '../concurrency/sleep';

// Cache-aside with a single-flight lock.
//
//   hit   → Redis only
//   miss  → SET lock:<key> <token> NX PX → the winner reads the database, writes
//           the value with a jittered TTL and releases its own lock; everybody
//           else polls the cache until the value shows up
//
// Everything here is an optimisation. If Redis is down, slow or full, a read
// degrades to a plain database read: a cache that turns its own failure into the
// user's failure is not a cache. That includes the lock — if it breaks, two
// requests read the same row twice, and nothing is corrupted.

export interface CacheAsideOptions {
  // TTL = ttlSeconds + random(0..jitterSeconds). Keys warmed in one pass would
  // otherwise all expire in the same second and stampede together.
  ttlSeconds: number;
  jitterSeconds: number;
  // A miss for something that does not exist is cached too, for less long, so a
  // stream of requests for a missing id does not reach the database every time.
  negativeTtlSeconds: number;
  // How long a lock holder may take before the lock lapses on its own.
  lockTtlMs: number;
  // How often a waiter re-reads the cache.
  pollMs: number;
  // false turns the lock off — the control run of the stampede demo.
  singleFlight: boolean;
}

export const DEFAULT_CACHE_OPTIONS: CacheAsideOptions = {
  ttlSeconds: 300,
  jitterSeconds: 60,
  negativeTtlSeconds: 30,
  lockTtlMs: 3000,
  pollMs: 20,
  singleFlight: true,
};

export type ReadSource = 'hit' | 'loaded' | 'waited' | 'degraded';

export interface CacheRead<T> {
  value: T | null;
  source: ReadSource;
}

// Compare-and-delete: only the holder of the token may release the lock. A bare
// DEL from a holder whose lock already lapsed would remove the lock somebody else
// took in the meantime. DELEX … IFEQ does this natively from Redis 8.4; the script
// works on any version.
const RELEASE_IF_OWNER = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

// The marker for "the database said there is no such row".
const ABSENT = '\u0000absent';

export class CacheAside {
  private readonly options: CacheAsideOptions;

  constructor(
    private readonly redis: Redis,
    options: Partial<CacheAsideOptions> = {},
  ) {
    this.options = { ...DEFAULT_CACHE_OPTIONS, ...options };
  }

  ttl(): number {
    return this.options.ttlSeconds + randomInt(0, this.options.jitterSeconds + 1);
  }

  async get<T>(key: string, load: () => Promise<T | null>): Promise<CacheRead<T>> {
    const cached = await this.peek<T>(key);
    if (cached !== undefined) return { value: cached, source: 'hit' };

    if (!this.options.singleFlight) return { value: await this.fill(key, load), source: 'loaded' };

    const deadline = Date.now() + this.options.lockTtlMs;
    let waited = false;

    for (;;) {
      const token = randomUUID();
      const acquired = await this.acquire(key, token);

      if (acquired === null) {
        // Redis refused the lock command itself: no single flight to be had.
        return { value: await load(), source: 'degraded' };
      }

      if (acquired) {
        try {
          // Double-check under the lock: the previous holder may have filled the
          // key between our miss and our SET NX.
          const filled = await this.peek<T>(key);
          if (filled !== undefined) return { value: filled, source: waited ? 'waited' : 'hit' };
          return { value: await this.fill(key, load), source: 'loaded' };
        } finally {
          await this.release(key, token);
        }
      }

      waited = true;
      await sleep(this.options.pollMs);

      const filled = await this.peek<T>(key);
      if (filled !== undefined) return { value: filled, source: 'waited' };

      // The holder is taking longer than its own lock: stop waiting for it and
      // read the database ourselves. Two reads instead of one, nothing worse.
      if (Date.now() > deadline) return { value: await load(), source: 'degraded' };
    }
  }

  async invalidate(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch (error) {
      warn('invalidate', key, error);
    }
  }

  // undefined = miss (or Redis unavailable), null = cached absence.
  private async peek<T>(key: string): Promise<T | null | undefined> {
    let raw: string | null;
    try {
      raw = await this.redis.get(key);
    } catch (error) {
      warn('get', key, error);
      return undefined;
    }
    if (raw === null) return undefined;
    if (raw === ABSENT) return null;
    return JSON.parse(raw) as T;
  }

  private async fill<T>(key: string, load: () => Promise<T | null>): Promise<T | null> {
    const value = await load();
    try {
      if (value === null) {
        await this.redis.set(key, ABSENT, 'EX', this.options.negativeTtlSeconds);
      } else {
        await this.redis.set(key, JSON.stringify(value), 'EX', this.ttl());
      }
    } catch (error) {
      // OOM on a misconfigured instance, a timeout, a dropped connection: the user
      // still gets the value they asked for.
      warn('set', key, error);
    }
    return value;
  }

  // true = ours, false = somebody else's, null = Redis did not answer.
  private async acquire(key: string, token: string): Promise<boolean | null> {
    try {
      return (await this.redis.set(lockKey(key), token, 'PX', this.options.lockTtlMs, 'NX')) === 'OK';
    } catch (error) {
      warn('lock', key, error);
      return null;
    }
  }

  private async release(key: string, token: string): Promise<void> {
    try {
      await releaseLock(this.redis, lockKey(key), token);
    } catch (error) {
      // The lock lapses on its own after lockTtlMs.
      warn('unlock', key, error);
    }
  }
}

export const lockKey = (key: string): string => `lock:${key}`;

export async function releaseLock(redis: Redis, key: string, token: string): Promise<boolean> {
  return (await redis.eval(RELEASE_IF_OWNER, 1, key, token)) === 1;
}

function warn(operation: string, key: string, error: unknown): void {
  console.error(`[cache] ${operation} ${key} failed: ${error instanceof Error ? error.message : error}`);
}
