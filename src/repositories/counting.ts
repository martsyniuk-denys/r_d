import { DataSource } from 'typeorm';
import { QueryResultRow } from 'pg';

import { Queryable } from './queryable';

// A Queryable that counts the statements it actually sends to the database. It
// sits under the repository, so what it counts is round trips to Postgres — not
// how many times somebody called a function that might or might not reach it.
export class CountingQueryable implements Queryable {
  private count = 0;

  constructor(private readonly inner: Queryable) {}

  get calls(): number {
    return this.count;
  }

  reset(): void {
    this.count = 0;
  }

  async query<T extends QueryResultRow>(sql: string, params: unknown[] = []) {
    this.count += 1;
    return this.inner.query<T>(sql, params);
  }
}

export function fromDataSource(dataSource: DataSource): Queryable {
  return {
    async query<T extends QueryResultRow>(sql: string, params: unknown[] = []) {
      const rows = (await dataSource.query(sql, params)) as T[];
      return { rows, rowCount: rows.length };
    },
  };
}
