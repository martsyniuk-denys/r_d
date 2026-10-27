import { randomBytes } from 'node:crypto';

import Redis from 'ioredis';

// Server-side session state in a Redis hash, with a rolling TTL.
//
// The store is the queue instance (noeviction + AOF), not the cache: under
// allkeys-lru a session is just another cold key, and evicting it logs somebody
// out at random — a bug nobody can reproduce. The process keeps nothing, so a
// session outlives a restart of the process, and every pod sees the same one.

export interface Session {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  hits: number;
}

// Read, count the request and push the expiry forward, in one round trip and one
// atomic step: a session that expires between the read and the EXPIRE would come
// back as a hash with a counter in it and no TTL at all — immortal.
const TOUCH = `
if redis.call("exists", KEYS[1]) == 0 then
  return nil
end
redis.call("hincrby", KEYS[1], "hits", 1)
redis.call("hset", KEYS[1], "lastSeenAt", ARGV[2])
redis.call("expire", KEYS[1], ARGV[1])
return redis.call("hgetall", KEYS[1])`;

export const sessionKey = (id: string): string => `sess:${id}`;

export class SessionStore {
  constructor(
    private readonly redis: Redis,
    readonly ttlSeconds: number,
  ) {}

  async create(): Promise<Session> {
    // 256 bits from the CSPRNG: the id is the only credential the client holds.
    const id = randomBytes(32).toString('base64url');
    const now = Date.now();
    await this.redis
      .multi()
      .hset(sessionKey(id), { createdAt: now, lastSeenAt: now, hits: 1 })
      .expire(sessionKey(id), this.ttlSeconds)
      .exec();
    return { id, createdAt: now, lastSeenAt: now, hits: 1 };
  }

  // null when the session is unknown or has expired.
  async touch(id: string): Promise<Session | null> {
    const flat = (await this.redis.eval(TOUCH, 1, sessionKey(id), this.ttlSeconds, Date.now())) as
      | string[]
      | null;
    if (flat === null) return null;

    const fields: Record<string, string> = {};
    for (let i = 0; i < flat.length; i += 2) fields[flat[i]] = flat[i + 1];
    return {
      id,
      createdAt: Number(fields.createdAt),
      lastSeenAt: Number(fields.lastSeenAt),
      hits: Number(fields.hits),
    };
  }

  async destroy(id: string): Promise<void> {
    await this.redis.del(sessionKey(id));
  }
}
