import { DataSource, EntityManager } from 'typeorm';
import { IsolationLevel } from 'typeorm/driver/types/IsolationLevel';

import { sleep } from './sleep';

export const RETRYABLE_SQL_STATES = new Set(['40001', '40P01']);

export interface RetryEvent {
  attempt: number;
  code: string;
  delayMs: number;
  message: string;
}

export interface RetryOptions {
  isolation?: IsolationLevel;
  maxAttempts?: number;
  baseDelayMs?: number;
  onRetry?: (event: RetryEvent) => void;
}

export interface RetryOutcome<T> {
  value: T;
  attempts: number;
  retries: RetryEvent[];
}

export function sqlState(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function backoff(baseDelayMs: number, attempt: number): number {
  const exponential = baseDelayMs * 2 ** (attempt - 1);
  return Math.min(exponential, 200) + Math.floor(Math.random() * baseDelayMs);
}

export async function runInTransactionWithRetry<T>(
  dataSource: DataSource,
  work: (manager: EntityManager, attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<RetryOutcome<T>> {
  const isolation = options.isolation ?? 'REPEATABLE READ';
  const maxAttempts = options.maxAttempts ?? 10;
  const baseDelayMs = options.baseDelayMs ?? 10;
  const retries: RetryEvent[] = [];

  for (let attempt = 1; ; attempt += 1) {
    const runner = dataSource.createQueryRunner();

    try {
      await runner.connect();
      await runner.startTransaction(isolation);
      const value = await work(runner.manager, attempt);
      await runner.commitTransaction();
      return { value, attempts: attempt, retries };
    } catch (error) {
      if (runner.isTransactionActive) {
        await runner.rollbackTransaction().catch(() => undefined);
      }

      const code = sqlState(error);
      if (code === undefined || !RETRYABLE_SQL_STATES.has(code) || attempt >= maxAttempts) {
        throw error;
      }

      const delayMs = backoff(baseDelayMs, attempt);
      const event: RetryEvent = {
        attempt,
        code,
        delayMs,
        message: error instanceof Error ? error.message : String(error),
      };
      retries.push(event);
      options.onRetry?.(event);
      await sleep(delayMs);
    } finally {
      await runner.release();
    }
  }
}
