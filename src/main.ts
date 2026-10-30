import type { ConfigService as ConfigServiceType } from '@nestjs/config';

import { validate } from './config/env.schema';
import type { Env } from './config/env.schema';

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
  validate(process.env);

  const { ConfigService } = await import('@nestjs/config');
  const { createApp, API_SPEC } = await import('./bootstrap');

  const app = await createApp();
  const config: ConfigServiceType<Env, true> = app.get(ConfigService);

  const port = config.get('PORT', { infer: true });
  app.enableShutdownHooks();
  await app.listen(port);

  console.log(`Marketplace API listening on http://localhost:${port}`);
  console.log(`Environment: ${config.get('NODE_ENV', { infer: true })}`);
  console.log(`Spec: ${API_SPEC} (requests and responses are validated against it)`);
}

main().catch((err: unknown) => {
  console.error(`\nStartup aborted.\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
