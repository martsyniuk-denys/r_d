import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import express, { Request, Response } from 'express';
import { z } from 'zod';

// The entry the Kubernetes Deployment runs: the stateless HTTP face of the API, from
// the same image as dist/main.js. It exists to answer three questions honestly:
//
//   GET /healthz  — "should I be killed?"   200 for as long as the event loop turns
//   GET /readyz   — "may I get traffic?"     200 only after the warm-up and before SIGTERM
//   GET /         — the work itself: which revision and which pod answered
//
// The warm-up before listen() stands in for migrations and a database pool. Without it
// the process starts faster than a rollout can break it, and a broken profile measures
// zero failures for the wrong reason.
//
// On SIGTERM the order is the point: /readyz goes red first, the pod keeps serving for
// DRAIN_MS while the endpoints controller and kube-proxy catch up, every response in
// that window says "Connection: close" so keep-alive clients move to another pod, and
// only then is the socket closed. Closing first refuses connections that kube-proxy is
// still sending here.

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // The pool's password: from the secret store, through a K8s Secret, by reference.
  DB_PASSWORD: z.string().min(1),
  REV: z.string().min(1).default('dev'),
  WARMUP_MS: z.coerce.number().int().min(0).default(4000),
  DRAIN_MS: z.coerce.number().int().min(0).default(5000),
});

type PodEnv = z.infer<typeof schema>;

function loadEnv(): PodEnv {
  const parsed = schema.safeParse(process.env);
  if (parsed.success) return parsed.data;
  const lines = parsed.error.issues.map((issue) => {
    const key = issue.path.join('.');
    const reason = process.env[key] === undefined ? 'Required (not set)' : issue.message;
    return `  - ${key}: ${reason}`;
  });
  throw new Error(`Invalid environment configuration — ${lines.length} problem(s):\n${lines.join('\n')}`);
}

function log(kind: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ kind, pod: hostname(), pid: process.pid, at: new Date().toISOString(), ...extra }));
}

async function main(): Promise<void> {
  const env = loadEnv();

  let state: 'warming' | 'ready' | 'draining' = 'warming';

  // A SIGTERM during the warm-up has nothing to drain: no socket is open yet.
  const abortWarmup = (): void => {
    log('terminated-while-warming');
    process.exit(0);
  };
  process.once('SIGTERM', abortWarmup);

  log('warming', { rev: env.REV, warmupMs: env.WARMUP_MS });
  await sleep(env.WARMUP_MS);

  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');

  app.use((_req: Request, res: Response, next) => {
    if (state === 'draining') res.setHeader('Connection', 'close');
    next();
  });

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ status: 'alive', uptime_seconds: Math.round(process.uptime() * 1000) / 1000 });
  });

  app.get('/readyz', (_req: Request, res: Response) => {
    res.status(state === 'ready' ? 200 : 503).json({ status: state });
  });

  app.get('/', (_req: Request, res: Response) => {
    res.json({ service: 'marketplace-api', rev: env.REV, pod: hostname(), pid: process.pid });
  });

  const server = app.listen(env.PORT, () => {
    // A SIGTERM between listen() and this event has already started the drain.
    if (state !== 'warming') return;
    state = 'ready';
    log('ready', { rev: env.REV, port: env.PORT });
  });
  // Longer than any load balancer's idle timeout: the client, not the pod, decides
  // when an idle keep-alive connection is over — except while draining.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  process.removeListener('SIGTERM', abortWarmup);
  process.once('SIGTERM', () => {
    state = 'draining';
    log('draining', { drainMs: env.DRAIN_MS });

    setTimeout(() => {
      log('closing');
      server.close(() => {
        log('closed');
        process.exit(0);
      });
      server.closeIdleConnections();
      setTimeout(() => server.closeAllConnections(), 2_000).unref();
    }, env.DRAIN_MS);
  });
}

main().catch((error: unknown) => {
  console.error(`\nStartup aborted.\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
