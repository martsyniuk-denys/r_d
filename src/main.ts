// Before anything else: OpenTelemetry patches http, express and pg as they are
// required, and can only patch what has not been loaded yet.
import './observability/tracing';

import type { ConfigService as ConfigServiceType } from '@nestjs/config';

import { validate } from './config/env.schema';
import type { Env } from './config/env.schema';
import { loadSecretFiles } from './config/secret-files';
import { layerLogger } from './observability/logger';
import { shutdownTracing } from './observability/tracing-shutdown';

const log = layerLogger('main');

// The configuration is validated as the first thing the process does, before
// Nest, the pg pool or anything else that could fail for a different reason is
// even imported: a bare start without a signing key must say "JWT_PRIVATE_KEY",
// not ECONNREFUSED. The .env file is read the way ConfigModule reads it (values
// already in the environment win), so both see the same configuration.
function loadEnvFile(): void {
  try {
    process.loadEnvFile('.env');
  } catch {
    return;
  }
}

async function main(): Promise<void> {
  loadEnvFile();
  loadSecretFiles();
  validate(process.env);

  const { ConfigService } = await import('@nestjs/config');
  const { createApp, API_SPEC } = await import('./bootstrap');

  const app = await createApp();
  const config: ConfigServiceType<Env, true> = app.get(ConfigService);

  const port = config.get('PORT', { infer: true });
  // SIGINT (a terminal) closes at once; SIGTERM (compose, the kubelet) drains first.
  app.enableShutdownHooks(['SIGINT']);
  await app.listen(port);

  const { ReadinessService } = await import('./health/readiness.service');
  const readiness = app.get(ReadinessService);
  const drainMs = config.get('SHUTDOWN_DRAIN_MS', { infer: true });
  process.once('SIGTERM', () => {
    readiness.drain();
    log.info({ drainMs }, 'SIGTERM: /readyz is 503, draining before close');
    setTimeout(() => {
      void app.close().then(
        () => {
          log.info('closed after drain');
          process.exit(0);
        },
        (err: unknown) => {
          log.error({ err }, 'close failed');
          process.exit(1);
        },
      );
    }, drainMs);
  });

  log.info(
    {
      port,
      env: config.get('NODE_ENV', { infer: true }),
      spec: API_SPEC,
      otlp: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || null,
    },
    `Marketplace API listening on http://localhost:${port}`,
  );
}

// The one human-readable output: the process never got as far as serving, and
// the reader is a person at a terminal looking for the name of a variable.
// The flush is capped: with the trace backend down, the exporter would hold a
// process that has already failed for its whole timeout.
const FLUSH_ON_ABORT_MS = 2000;

main().catch(async (err: unknown) => {
  console.error(`\nStartup aborted.\n${err instanceof Error ? err.message : String(err)}\n`);
  await Promise.race([shutdownTracing(), new Promise((resolve) => setTimeout(resolve, FLUSH_ON_ABORT_MS).unref())]);
  process.exit(1);
});
