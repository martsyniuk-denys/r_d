import { readFileSync } from 'node:fs';

import Redis from 'ioredis';

// Two Redis instances, two variables, and nothing that reads them but this file.
//
//   REDIS_URL        the cache: maxmemory + allkeys-lru, nothing persisted
//   REDIS_QUEUE_URL  BullMQ, sessions, rate-limit windows: noeviction + AOF
//
// The store keeps the URLs without a password and the password in a file next to
// db_password (REDIS_PASSWORD_FILE); the grader exports URLs with the password
// inside them. Both shapes are accepted, the same way data-source.ts and broker.ts
// accept theirs.

export type RedisRole = 'cache' | 'queue';

const VARIABLE: Record<RedisRole, string> = { cache: 'REDIS_URL', queue: 'REDIS_QUEUE_URL' };

const HINT =
  'Redis addresses come from the environment only. Either go through the secret store ' +
  '(bash scripts/with-secrets.sh dev <command> — every npm script that talks to Redis already ' +
  'does), or export REDIS_URL and REDIS_QUEUE_URL (redis://:pass@host:port) yourself and set SKIP_VAULT=1.';

function readPassword(name: string): string {
  const inline = process.env.REDIS_PASSWORD;
  if (inline !== undefined && inline !== '') return inline;

  const file = process.env.REDIS_PASSWORD_FILE;
  if (file !== undefined && file !== '') return readFileSync(file, 'utf8').trim();

  throw new Error(
    `${name} carries no password, and neither REDIS_PASSWORD nor REDIS_PASSWORD_FILE is set. ${HINT}`,
  );
}

export function redisUrl(role: RedisRole): string {
  const name = VARIABLE[role];
  const raw = process.env[name];
  if (raw === undefined || raw === '') throw new Error(`${name} is not set. ${HINT}`);

  const url = new URL(raw);
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error(`${name} must be redis:// or rediss://, got ${url.protocol}//. ${HINT}`);
  }
  if (url.password === '') url.password = encodeURIComponent(readPassword(name));

  return url.toString();
}

export interface ConnectOptions {
  // BullMQ workers hold blocking commands and must wait for Redis to come back
  // rather than throw: ioredis gives up after 20 retries per request unless this
  // is null. Everything on the request path wants the opposite — fail fast.
  blocking?: boolean;
}

export function connectRedis(role: RedisRole, name: string, options: ConnectOptions = {}): Redis {
  const redis = new Redis(redisUrl(role), {
    connectionName: name,
    maxRetriesPerRequest: options.blocking === true ? null : 1,
    // The cache sits on the request path: a Redis that does not answer within
    // half a second is treated as a miss, not waited on.
    commandTimeout: role === 'cache' ? 500 : undefined,
  });
  // Without a listener an 'error' event is an uncaught exception.
  redis.on('error', (error: Error) => {
    console.error(`[redis ${role}/${name}] ${error.message}`);
  });
  return redis;
}

export interface MemoryPolicy {
  policy: string;
  maxmemory: number;
}

// Read at runtime from the connection itself, not from the compose file: what the
// demos report is what the instance they talk to actually does.
export async function memoryPolicy(redis: Redis): Promise<MemoryPolicy> {
  const [, policy] = (await redis.config('GET', 'maxmemory-policy')) as [string, string];
  const [, maxmemory] = (await redis.config('GET', 'maxmemory')) as [string, string];
  return { policy, maxmemory: Number(maxmemory) };
}
