import { EntityManager } from 'typeorm';
import { QueryResultRow } from 'pg';

export interface Queryable {
  query<T extends QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

export function fromEntityManager(manager: EntityManager): Queryable {
  const runner = manager.queryRunner;
  if (runner === undefined) {
    throw new Error('fromEntityManager() needs a manager bound to a transaction');
  }

  return {
    async query<T extends QueryResultRow>(sql: string, params: unknown[] = []) {
      const result = await runner.query(sql, params, true);
      const rows = result.records as T[];
      return { rows, rowCount: result.affected ?? rows.length };
    },
  };
}
