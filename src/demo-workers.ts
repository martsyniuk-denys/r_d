import 'reflect-metadata';

import { DataSource } from 'typeorm';

import { WorkerReport, runWorker } from './concurrency/worker';
import { dataSourceOptions } from './data-source';

const JOBS = 24;
const WORKERS = 4;
const WORK_MS = 40;

async function prepare(dataSource: DataSource): Promise<void> {
  await dataSource.query(`DELETE FROM jobs`);
  await dataSource.query(
    `INSERT INTO jobs (type, payload)
     SELECT 'order_receipt', jsonb_build_object('demo', g)
     FROM generate_series(1, $1) AS g`,
    [JOBS],
  );
}

async function main(): Promise<void> {
  const dataSource = new DataSource({ ...dataSourceOptions, poolSize: WORKERS + 2 });
  await dataSource.initialize();

  const failures: string[] = [];
  const check = (label: string, ok: boolean, detail: string): void => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}: ${detail}`);
    if (!ok) failures.push(label);
  };

  try {
    await prepare(dataSource);

    console.log(
      `${WORKERS} workers draining ${JOBS} jobs with FOR UPDATE SKIP LOCKED, ` +
        `${WORK_MS} ms of work per job\n`,
    );

    const startedAt = Date.now();
    const reports: WorkerReport[] = await Promise.all(
      Array.from({ length: WORKERS }, (_, index) =>
        runWorker(dataSource, { name: `worker-${index + 1}`, workMs: WORK_MS }),
      ),
    );
    const elapsedMs = Date.now() - startedAt;

    const [{ twice }]: { twice: string }[] = await dataSource.query(
      `SELECT count(*) AS twice FROM jobs WHERE processed > 1`,
    );
    const [{ pending }]: { pending: string }[] = await dataSource.query(
      `SELECT count(*) AS pending FROM jobs WHERE status = 'pending'`,
    );
    const [{ done }]: { done: string }[] = await dataSource.query(
      `SELECT count(*) AS done FROM jobs WHERE status = 'done' AND processed = 1`,
    );
    const byWorker: { processed_by: string; jobs: string }[] = await dataSource.query(
      `SELECT processed_by, count(*) AS jobs FROM jobs GROUP BY processed_by ORDER BY processed_by`,
    );

    const claimed = reports.reduce((sum, report) => sum + report.jobIds.length, 0);
    const sequentialMs = JOBS * WORK_MS;

    console.log('distribution (from the jobs table, not from the workers)');
    for (const row of byWorker) {
      const report = reports.find((item) => item.name === row.processed_by);
      console.log(
        `  ${String(row.processed_by).padEnd(10, ' ')} ${String(row.jobs).padStart(3, ' ')} jobs` +
          (report ? `   (${report.emptyPolls} empty polls before it stopped)` : ''),
      );
    }

    console.log('');
    console.log(`jobs enqueued            ${JOBS}`);
    console.log(`jobs claimed by workers  ${claimed}`);
    console.log(`processed exactly once   ${done}`);
    console.log(`processed twice          ${twice}`);
    console.log(`still pending            ${pending}`);
    console.log(`wall clock               ${elapsedMs} ms`);
    console.log(`the same work sequential ${sequentialMs} ms (${JOBS} x ${WORK_MS} ms)\n`);

    console.log('invariants');
    check('processed twice is zero', Number(twice) === 0, `${twice}`);
    check('the queue is empty', Number(pending) === 0, `${pending}`);
    check(
      'every job processed exactly once',
      Number(done) === JOBS,
      `${done} === ${JOBS}`,
    );
    check(
      'no job was claimed twice',
      claimed === JOBS,
      `${claimed} claims for ${JOBS} jobs`,
    );
    check(
      'more than one worker did the work',
      byWorker.length >= 2,
      `${byWorker.length} workers`,
    );
    check(
      'faster than sequential',
      elapsedMs < sequentialMs,
      `${elapsedMs} ms < ${sequentialMs} ms`,
    );
  } finally {
    await dataSource.destroy();
  }

  if (failures.length > 0) {
    console.error(`\nthe pool is not honest — ${failures.length} broken invariant(s)`);
    process.exit(1);
  }

  console.log('\nSKIP LOCKED handed every job to exactly one worker; nothing was processed twice.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
