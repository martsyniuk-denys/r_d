import 'reflect-metadata';

import { DataSource } from 'typeorm';

import { RETRYABLE_SQL_STATES, RetryEvent, runInTransactionWithRetry } from './concurrency/retry';
import { sleep } from './concurrency/sleep';
import { dataSourceOptions } from './data-source';

const WRITERS = 8;
const STEP_MINOR = 10_000;
const START_MINOR = 5_000_000;
const MAX_ATTEMPTS = 20;

function barrier(parties: number, timeoutMs: number): () => Promise<void> {
  let arrived = 0;
  let open = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const timer = setTimeout(() => open(), timeoutMs);

  return async () => {
    arrived += 1;
    if (arrived >= parties) {
      clearTimeout(timer);
      open();
    }
    await gate;
  };
}

const oneLine = (message: string): string => message.replace(/\s+/g, ' ').trim();

async function main(): Promise<void> {
  const dataSource = new DataSource({
    ...dataSourceOptions,
    poolSize: WRITERS + 2,
    logging: ['warn'],
  });
  await dataSource.initialize();

  const failures: string[] = [];
  const check = (label: string, ok: boolean, detail: string): void => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}: ${detail}`);
    if (!ok) failures.push(label);
  };

  try {
    const buyers: { id: string }[] = await dataSource.query(
      `SELECT DISTINCT buyer_id AS id FROM orders ORDER BY 1 LIMIT 1`,
    );
    if (buyers.length === 0) throw new Error('no buyers — run npm run seed first');

    const buyerId = buyers[0].id;
    await dataSource.query(`UPDATE users SET balance_minor = $2 WHERE id = $1`, [
      buyerId,
      START_MINOR,
    ]);

    console.log(
      `${WRITERS} concurrent read-modify-write transactions under REPEATABLE READ,\n` +
        `each debiting ${STEP_MINOR} minor units from balance ${START_MINOR} of user ${buyerId}.\n` +
        'The read happens in SQL, the arithmetic in JavaScript, the write without a lock —\n' +
        'so the database has to reject every writer whose snapshot went stale.\n',
    );

    const gate = barrier(WRITERS, 5000);
    const caught: RetryEvent[] = [];
    const startedAt = Date.now();

    const outcomes = await Promise.all(
      Array.from({ length: WRITERS }, (_, index) =>
        runInTransactionWithRetry(
          dataSource,
          async (manager, attempt) => {
            const rows: { balance_minor: number }[] = await manager.query(
              `SELECT balance_minor FROM users WHERE id = $1`,
              [buyerId],
            );
            const current = Number(rows[0].balance_minor);

            if (attempt === 1) await gate();
            else await sleep(5 + index);

            const next = current - STEP_MINOR;
            await manager.query(`UPDATE users SET balance_minor = $2 WHERE id = $1`, [
              buyerId,
              next,
            ]);

            return next;
          },
          {
            isolation: 'REPEATABLE READ',
            maxAttempts: MAX_ATTEMPTS,
            onRetry: (event) => {
              caught.push(event);
              console.log(
                `  writer-${String(index + 1).padStart(2, ' ')}  attempt ${event.attempt} ` +
                  `hit ${event.code}, retrying the whole transaction in ${event.delayMs} ms` +
                  `\n            ${oneLine(event.message)}`,
              );
            },
          },
        ).then((outcome) => ({ writer: index + 1, ...outcome })),
      ),
    );

    const elapsedMs = Date.now() - startedAt;

    const [{ balance_minor: finalBalance }]: { balance_minor: number }[] = await dataSource.query(
      `SELECT balance_minor FROM users WHERE id = $1`,
      [buyerId],
    );
    const expected = START_MINOR - WRITERS * STEP_MINOR;

    const byCode = new Map<string, number>();
    for (const event of caught) byCode.set(event.code, (byCode.get(event.code) ?? 0) + 1);

    console.log('');
    console.log('attempts per writer');
    for (const outcome of outcomes) {
      console.log(
        `  writer-${String(outcome.writer).padStart(2, ' ')}  ` +
          `${outcome.attempts} attempt(s), ${outcome.retries.length} retry(ies)`,
      );
    }

    console.log('');
    console.log(`serialization failures caught  ${caught.length}`);
    for (const [code, times] of [...byCode.entries()].sort()) {
      console.log(`  ${code}  ${times}`);
    }
    console.log(`balance before                 ${START_MINOR}`);
    console.log(`balance after                  ${finalBalance}`);
    console.log(`expected                       ${expected} (${START_MINOR} - ${WRITERS} x ${STEP_MINOR})`);
    console.log(`wall clock                     ${elapsedMs} ms\n`);

    console.log('invariants');
    check(
      'the arithmetic survived the race',
      Number(finalBalance) === expected,
      `${finalBalance} === ${expected}`,
    );
    check(
      'at least one serialization failure was caught and retried',
      caught.length > 0,
      `${caught.length}`,
    );
    check(
      'only 40001 / 40P01 were retried',
      caught.every((event) => RETRYABLE_SQL_STATES.has(event.code)),
      [...byCode.keys()].join(', ') || 'none',
    );
    check(
      'every writer eventually committed',
      outcomes.length === WRITERS,
      `${outcomes.length} === ${WRITERS}`,
    );
  } finally {
    await dataSource.destroy();
  }

  if (failures.length > 0) {
    console.error(`\nretry did not hold — ${failures.length} broken invariant(s)`);
    process.exit(1);
  }

  console.log(
    '\nEvery retry re-read the balance inside a new transaction, so no update was lost.',
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
