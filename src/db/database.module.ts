import { readFile } from 'node:fs/promises';

import { Global, Module, OnApplicationShutdown, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';

import { Env } from '../config/env.schema';

export const PG_POOL = Symbol('PG_POOL');

export function createPool(config: ConfigService<Env, true>): Pool {
  const url = new URL(config.get('DB_URL', { infer: true }));
  const passwordFile = config.get('DB_PASSWORD_FILE', { infer: true });

  const pool = new Pool({
    host: url.hostname,
    port: Number(url.port || 5432),
    database: url.pathname.replace(/^\//, ''),
    user: decodeURIComponent(url.username),
    password: async () => (await readFile(passwordFile, 'utf8')).trim(),
    max: config.get('DB_POOL_MAX', { infer: true }),
    connectionTimeoutMillis: config.get('DB_CONNECTION_TIMEOUT_MS', { infer: true }),
  });

  pool.on('error', (err) => {
    console.error('[pg] idle client error:', err.message);
  });

  return pool;
}

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: createPool,
    },
  ],
  exports: [PG_POOL],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
