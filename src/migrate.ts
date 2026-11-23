import 'reflect-metadata';

import { AppDataSource } from './data-source';
import { seed } from './seed';

// The `migrate` one-shot of docker-compose.yml: the image has no shell and no npx,
// so `typeorm migration:run && node dist/seed.js` becomes one entry. Both halves
// are safe to repeat — applied migrations are skipped by the migrations table, and
// the seed upserts by natural key — so every `docker compose up` runs it again, and
// the API, relay and consumer start only after it exits 0.
async function main(): Promise<void> {
  const dataSource = await AppDataSource.initialize();
  try {
    const applied = await dataSource.runMigrations({ transaction: 'each' });
    console.log(JSON.stringify({ kind: 'migrations', applied: applied.map((m) => m.name) }));
  } finally {
    await dataSource.destroy();
  }
  await seed();
}

main().catch((error: unknown) => {
  console.error(`[migrate] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
