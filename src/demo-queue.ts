import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { Invariants, pause, report, runDemo } from './common/demo-output';
import {
  ORDER_PLACED_JOB,
  RECOMPUTE_RATINGS_SCHEDULER,
  enqueueOrderPlaced,
  openQueue,
  scheduleRatingsRecompute,
  startWorker,
} from './queue/notifications';
import { connectRedis, memoryPolicy } from './redis/connection';

// The BullMQ queue: retries with backoff, dedup by jobId, and a job scheduler.
//
//   1. the same order.placed event enqueued twice (the relay is at-least-once)
//      → two adds, one job
//   2. the ratings scheduler upserted twice (two restarts) → one scheduler
//   3. a worker starts; the confirmation job fails twice (a 503 from the mail
//      provider), is retried with exponential backoff and completes on attempt 3;
//      meanwhile the scheduler keeps producing ratings jobs
//   4. the event arrives once more after the job completed → still one job

const FAIL_TIMES = 2;
const SCHEDULE_EVERY_MS = 400;
const OBSERVE_MS = 2500;
const TIMEOUT_MS = 15_000;

runDemo(async () => {
  const invariants = new Invariants();
  // The queue side fails fast; the worker waits Redis out (maxRetriesPerRequest: null).
  const connection = connectRedis('queue', 'demo-queue');
  const workerConnection = connectRedis('queue', 'demo-queue-worker', { blocking: true });
  const queue = openQueue(connection);
  let worker: ReturnType<typeof startWorker> | undefined;

  const cleanup = async (): Promise<void> => {
    await queue.removeJobScheduler(RECOMPUTE_RATINGS_SCHEDULER);
    await queue.obliterate({ force: true });
  };

  try {
    await cleanup();

    const { policy } = await memoryPolicy(connection);
    console.log(`queue instance: maxmemory-policy ${policy}\n`);

    // 1. dedup
    const eventId = randomUUID();
    const job = { eventId, orderId: 'demo', failTimes: FAIL_TIMES };
    const first = await enqueueOrderPlaced(queue, job);
    const second = await enqueueOrderPlaced(queue, job);
    const added = 2;
    const counts = await queue.getJobCounts();
    const queued = Object.values(counts).reduce((sum, n) => sum + n, 0);
    console.log(`1. add × ${added} with jobId ${first.id} → ${queued} job in the queue (second add returned ${second.id})`);

    // 2. scheduler, upserted the way every restart would
    await scheduleRatingsRecompute(queue, SCHEDULE_EVERY_MS);
    await scheduleRatingsRecompute(queue, SCHEDULE_EVERY_MS);
    const schedulers = (await queue.getJobSchedulers()).length;
    console.log(`2. upsertJobScheduler × 2 → ${schedulers} scheduler (every ${SCHEDULE_EVERY_MS} ms)`);

    // 3. the worker
    let attempts = 0;
    let completed = 0;
    let scheduledRuns = 0;
    const startedAt = Date.now();
    let lastAttemptAt = startedAt;
    console.log('3. worker started');

    worker = startWorker(workerConnection, {
      async orderPlaced(j) {
        attempts += 1;
        const now = Date.now();
        const gap = attempts === 1 ? '' : `, ${now - lastAttemptAt} ms after the previous one`;
        lastAttemptAt = now;
        if (j.attemptsMade < (j.data.failTimes ?? 0)) {
          console.log(`   attempt ${attempts}: mail provider answered 503${gap}`);
          throw new Error('mail provider: 503 Service Unavailable');
        }
        console.log(`   attempt ${attempts}: confirmation for order ${j.data.orderId} sent${gap}`);
      },
      async recomputeRatings() {
        scheduledRuns += 1;
      },
    });
    worker.on('completed', (j) => {
      if (j.name === ORDER_PLACED_JOB) completed += 1;
    });
    worker.on('error', (error) => console.error(`[worker] ${error.message}`));

    while ((completed < 1 || Date.now() - startedAt < OBSERVE_MS) && Date.now() - startedAt < TIMEOUT_MS) {
      await pause(50);
    }
    const runsInWindow = scheduledRuns;
    console.log(`   scheduler: ${runsInWindow} runs in ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);

    // 4. the same event once more, after the job completed
    const late = await enqueueOrderPlaced(queue, job);
    const lateState = await late.getState();
    const orderJobs = (await queue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed'])).filter(
      (j) => j.name === ORDER_PLACED_JOB,
    ).length;
    console.log(`4. add after completion → job ${late.id} is ${lateState}; ${orderJobs} confirmation job in total\n`);

    invariants.check('queue instance never evicts', policy === 'noeviction', policy);
    invariants.check('two adds, one job', queued === 1, `${queued}`);
    invariants.check('one scheduler after two upserts', schedulers === 1, `${schedulers}`);
    invariants.check('failed twice, then completed', attempts === FAIL_TIMES + 1 && completed === 1, `${attempts} attempts, ${completed} completed`);
    invariants.check('scheduler ran repeatedly', runsInWindow >= 2, `${runsInWindow}`);
    invariants.check('a late duplicate is still a duplicate', orderJobs === 1 && completed === 1, `${orderJobs}`);
    console.log('');

    report({
      'queue-noeviction': policy === 'noeviction' ? 1 : 0,
      attempts,
      completed,
      added,
      queued,
      schedulers,
      'scheduled-runs': runsInWindow,
      'deduped-after-complete': orderJobs === 1 ? 1 : 0,
    });

    return invariants.broken === 0 ? 0 : 1;
  } finally {
    await worker?.close();
    await cleanup();
    await queue.close();
    await workerConnection.quit();
    await connection.quit();
  }
});
