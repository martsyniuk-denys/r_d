import { randomUUID } from 'node:crypto';

import { NextFunction, Request, RequestHandler, Response } from 'express';
import Redis from 'ioredis';

// Sliding-window log in a sorted set: one member per admitted request, scored by
// the time it was admitted. A request is allowed when fewer than `limit` members
// are younger than `windowMs`. No burst at a window boundary — that is the point
// of choosing it over a fixed window, which lets 2 × limit through around the
// moment the counter resets.
//
// One Lua script, not ZREMRANGEBYSCORE + ZCARD + ZADD from the client: between the
// ZCARD and the ZADD another pod gets in, both see limit - 1, both are admitted,
// and the limit leaks exactly when it is under load. Here atomicity is what makes
// the limit correct, not an optimisation. The clock is Redis's own TIME, so pods
// whose clocks disagree still share one window.
const SLIDING_WINDOW = `
local key = KEYS[1]
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local t = redis.call("time")
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

redis.call("zremrangebyscore", key, "-inf", now - window)
local count = redis.call("zcard", key)
if count < limit then
  redis.call("zadd", key, now, now .. "-" .. ARGV[3])
  redis.call("pexpire", key, window)
  return {1, limit - count - 1, 0}
end

local oldest = redis.call("zrange", key, 0, 0, "WITHSCORES")
return {0, 0, tonumber(oldest[2]) + window - now}`;

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
  prefix?: string;
}

export interface Decision {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export class SlidingWindowLimiter {
  private readonly prefix: string;

  constructor(
    private readonly redis: Redis,
    readonly options: RateLimitOptions,
  ) {
    this.prefix = options.prefix ?? 'rl';
  }

  key(client: string): string {
    return `${this.prefix}:${client}`;
  }

  async hit(client: string): Promise<Decision> {
    const [allowed, remaining, retryAfterMs] = (await this.redis.eval(
      SLIDING_WINDOW,
      1,
      this.key(client),
      this.options.windowMs,
      this.options.limit,
      randomUUID(),
    )) as [number, number, number];
    return { allowed: allowed === 1, remaining, retryAfterMs };
  }
}

// Who is being limited: the X-Client-Id header if the caller sends one (an API key
// in real life), the socket address otherwise.
const clientOf = (req: Request): string => req.header('x-client-id') ?? req.ip ?? 'unknown';

export function rateLimitMiddleware(limiter: SlidingWindowLimiter): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    let decision: Decision;
    try {
      decision = await limiter.hit(clientOf(req));
    } catch (error) {
      // Fail open: with Redis gone the limit is not enforced for a while, which
      // is better than the limiter turning a Redis outage into an API outage.
      console.error(`[ratelimit] ${error instanceof Error ? error.message : error} — request let through`);
      return next();
    }

    res.setHeader('RateLimit-Limit', String(limiter.options.limit));
    res.setHeader('RateLimit-Remaining', String(decision.remaining));
    if (decision.allowed) return next();

    // Retry-After is whole seconds; round up so a client that obeys it is not
    // turned away again for being a few hundred milliseconds early.
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))));
    res.status(429).type('application/problem+json').json({
      type: 'about:blank',
      title: 'Too Many Requests',
      status: 429,
      detail: `At most ${limiter.options.limit} requests per ${limiter.options.windowMs / 1000} s.`,
    });
  };
}
