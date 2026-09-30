import { join } from 'node:path';

import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';

import { Job, Order, OrderItem, Product, User } from '../../src/entities';
import { publishConnectionUri } from './database';

declare global {
  // eslint-disable-next-line no-var
  var __PG_CONTAINER__: StartedPostgreSqlContainer | undefined;
}

export default async function globalSetup(): Promise<void> {
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('marketplace')
    .withUsername('marketplace')
    .withPassword('marketplace_test_password')
    .start();

  const uri = container.getConnectionUri();

  // The schema comes from the real migrations, not from a hand-written fixture:
  // what the suite tests against is what production runs.
  const dataSource = new DataSource({
    type: 'postgres',
    url: uri,
    // The entities are here for one reason: the initial migration writes into
    // typeorm_metadata, and TypeORM only creates that table when it knows about
    // an entity with a generated column (products.search_vector).
    entities: [User, Product, Order, OrderItem, Job],
    migrations: [join(__dirname, '..', '..', 'src', 'migrations', '*.ts')],
    migrationsTableName: 'migrations',
    synchronize: false,
    logging: ['error'],
  });

  await dataSource.initialize();
  await dataSource.runMigrations({ transaction: 'all' });
  await dataSource.destroy();

  globalThis.__PG_CONTAINER__ = container;
  publishConnectionUri(uri);
}
