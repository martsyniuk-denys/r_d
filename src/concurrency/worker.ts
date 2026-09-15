import { DataSource, EntityManager } from 'typeorm';

import { Job } from '../entities';
import { sleep } from './sleep';

export interface WorkerOptions {
  name: string;
  workMs: number;
  idleChecks?: number;
  idleDelayMs?: number;
}

export interface WorkerReport {
  name: string;
  jobIds: string[];
  emptyPolls: number;
}

export function claimJob(manager: EntityManager): Promise<Job | null> {
  return manager
    .createQueryBuilder(Job, 'job')
    .setLock('pessimistic_write')
    .setOnLocked('skip_locked')
    .where('job.status = :status', { status: 'pending' })
    .orderBy('job.id', 'ASC')
    .limit(1)
    .getOne();
}

export async function runWorker(
  dataSource: DataSource,
  options: WorkerOptions,
): Promise<WorkerReport> {
  const idleChecks = options.idleChecks ?? 3;
  const idleDelayMs = options.idleDelayMs ?? 25;
  const jobIds: string[] = [];
  let emptyPolls = 0;
  let idle = 0;

  while (idle < idleChecks) {
    const jobId = await dataSource.transaction(async (manager) => {
      const job = await claimJob(manager);
      if (job === null) return null;

      await sleep(options.workMs);

      await manager.query(
        `UPDATE jobs
            SET status = 'done',
                processed = processed + 1,
                attempts = attempts + 1,
                processed_by = $2,
                processed_at = now()
          WHERE id = $1`,
        [job.id, options.name],
      );

      return job.id;
    });

    if (jobId === null) {
      emptyPolls += 1;
      idle += 1;
      await sleep(idleDelayMs);
      continue;
    }

    idle = 0;
    jobIds.push(jobId);
  }

  return { name: options.name, jobIds, emptyPolls };
}
