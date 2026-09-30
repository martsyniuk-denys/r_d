import 'reflect-metadata';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DataSource } from 'typeorm';
import { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

import { Job, Order, OrderItem, Product, User } from './entities';

const HINT =
  'Connection values come from the environment only. Either go through the secret store ' +
  '(bash scripts/with-secrets.sh dev <command> — every npm script that touches the database ' +
  'already does), or export DATABASE_URL (or DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME) ' +
  'yourself and set SKIP_VAULT=1.';

function required(name: string, value: string | undefined): string {
  if (value === undefined || value === '') throw new Error(`${name} is not set. ${HINT}`);
  return value;
}

interface Target {
  host: string;
  port: number;
  username: string;
  database: string;
}

function connectionUrl(): URL | undefined {
  const raw = process.env.DB_URL ?? process.env.DATABASE_URL;
  if (raw === undefined || raw === '') return undefined;
  return new URL(raw);
}

const url = connectionUrl();

function target(): Target {
  if (url !== undefined) {
    return {
      host: required('connection URL host', url.hostname),
      port: Number(url.port || 5432),
      username: required('connection URL user', decodeURIComponent(url.username)),
      database: required('connection URL database', url.pathname.replace(/^\//, '')),
    };
  }

  return {
    host: required('DB_HOST', process.env.DB_HOST),
    port: Number(process.env.DB_PORT ?? 5432),
    username: required('DB_USER', process.env.DB_USER),
    database: required('DB_NAME', process.env.DB_NAME),
  };
}

function readPassword(): string {
  const inline = process.env.DB_PASSWORD;
  if (inline !== undefined && inline !== '') return inline;

  if (url !== undefined && url.password !== '') return decodeURIComponent(url.password);

  const file = process.env.DB_PASSWORD_FILE;
  if (file !== undefined && file !== '') return readFileSync(file, 'utf8').trim();

  throw new Error(`Neither DB_PASSWORD nor DB_PASSWORD_FILE is set. ${HINT}`);
}

export const dataSourceOptions: PostgresConnectionOptions = {
  type: 'postgres',
  ...target(),
  password: readPassword(),
  entities: [User, Product, Order, OrderItem, Job],
  migrations: [join(__dirname, 'migrations', '*.js')],
  migrationsTableName: 'migrations',
  synchronize: false,
  logging: ['error', 'warn', 'migration'],
};

export const AppDataSource = new DataSource(dataSourceOptions);
