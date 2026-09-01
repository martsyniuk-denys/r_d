import type { ConfigService as ConfigServiceType } from '@nestjs/config';

import type { Env } from './config/env.schema';

async function main(): Promise<void> {
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
