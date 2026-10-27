import 'reflect-metadata';

import { parseArgs } from 'node:util';

import express, { Request, Response } from 'express';

import { rateLimitMiddleware, SlidingWindowLimiter } from './ratelimit/sliding-window';
import { connectRedis } from './redis/connection';
import { SessionStore } from './sessions/session-store';
import { sessionMiddleware } from './sessions/session.middleware';

// One "pod" of the API edge: sessions and the rate limit, and no state of its own.
// Both live on the queue instance of Redis, so any number of these processes share
// one session per cookie and one window per client. The session and rate-limit
// demos start it as a child process — two at once, or one killed and replaced.
//
//   node dist/pod.js [--port 0] [--session-ttl 1800] [--limit 5] [--window-ms 10000]
//
// Prints one JSON line when it listens: {"kind":"ready","pid":…,"url":"http://…"}.

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '0' },
    'session-ttl': { type: 'string', default: '1800' },
    limit: { type: 'string', default: '5' },
    'window-ms': { type: 'string', default: '10000' },
    'rate-prefix': { type: 'string', default: 'rl' },
  },
});

async function main(): Promise<void> {
  const redis = connectRedis('queue', `pod-${process.pid}`);
  const sessions = new SessionStore(redis, Number(values['session-ttl']));
  const limiter = new SlidingWindowLimiter(redis, {
    limit: Number(values.limit),
    windowMs: Number(values['window-ms']),
    prefix: values['rate-prefix'],
  });

  const app = express();
  app.disable('x-powered-by');

  app.get('/session', sessionMiddleware(sessions), (req: Request, res: Response) => {
    res.json({ pid: process.pid, hits: req.session?.hits, createdAt: req.session?.createdAt });
  });

  app.get('/limited', rateLimitMiddleware(limiter), (_req: Request, res: Response) => {
    res.json({ pid: process.pid, ok: true });
  });

  const server = app.listen(Number(values.port), '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    console.log(JSON.stringify({ kind: 'ready', pid: process.pid, url: `http://127.0.0.1:${port}` }));
  });

  const shutdown = (): void => {
    server.close(() => {
      redis.quit().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
