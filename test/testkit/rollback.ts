import { Pool, PoolClient } from 'pg';

import { testPool } from './database';

export interface RollbackContext {
  /** The connection every repository under test is built on. */
  db: () => PoolClient;
  /**
   * Runs an operation that is expected to fail a constraint. A failed statement
   * poisons the whole transaction, so the attempt gets its own savepoint and the
   * test can keep going afterwards.
   */
  attempt: <T>(operation: () => Promise<T>) => Promise<T>;
}

/**
 * Isolation: every test runs inside its own transaction which is rolled back
 * afterwards. Nothing is ever committed, so the suite is repeatable without a
 * TRUNCATE step and the container is started once for the whole run.
 */
export function withRollback(): RollbackContext {
  let pool: Pool;
  let client: PoolClient;
  let savepoints = 0;

  beforeAll(() => {
    pool = testPool();
  });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
    client.release();
  });

  afterAll(async () => {
    await pool.end();
  });

  return {
    db: () => client,
    attempt: async <T>(operation: () => Promise<T>): Promise<T> => {
      const name = `attempt_${++savepoints}`;
      await client.query(`SAVEPOINT ${name}`);
      try {
        return await operation();
      } finally {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      }
    },
  };
}
