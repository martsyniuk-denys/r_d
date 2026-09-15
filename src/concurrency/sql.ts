import { EntityManager } from 'typeorm';
import { QueryResult } from 'typeorm/query-runner/QueryResult';

export async function returning<T>(
  manager: EntityManager,
  sql: string,
  parameters: unknown[],
): Promise<T[]> {
  const runner = manager.queryRunner;
  if (runner === undefined) throw new Error('returning() must be called inside a transaction');

  const result: QueryResult = await runner.query(sql, parameters, true);
  return result.records as T[];
}
