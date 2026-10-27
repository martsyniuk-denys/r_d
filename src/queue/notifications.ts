import { Job, JobsOptions, Queue, Worker } from 'bullmq';
import Redis from 'ioredis';

// One BullMQ queue for work that has no business inside an HTTP request:
//
//   order-placed       the confirmation to the buyer for an order.placed event
//   recompute-ratings  a periodic job created by a job scheduler
//
// It lives on the queue instance (noeviction): BullMQ keeps its state in plain
// Redis keys, and an evicted key is a job that silently stops existing.

export const NOTIFICATIONS_QUEUE = 'order-notifications';
export const ORDER_PLACED_JOB = 'order-placed';
export const RECOMPUTE_RATINGS_JOB = 'recompute-ratings';
export const RECOMPUTE_RATINGS_SCHEDULER = 'recompute-ratings';

export interface OrderPlacedJob {
  eventId: string;
  orderId: string;
  // How many attempts should fail before one succeeds: the demo's stand-in for a
  // mail provider answering 503. Absent in real use.
  failTimes?: number;
}

export type NotificationJob = OrderPlacedJob | Record<string, never>;

export const ORDER_PLACED_OPTIONS: JobsOptions = {
  attempts: 4,
  // 200 ms, 400 ms, 800 ms, each cut by a random share of up to half, so a batch
  // that failed together does not retry together.
  backoff: { type: 'exponential', delay: 200, jitter: 0.5 },
  // Not `true`: a removed job no longer counts as a duplicate, and dedup by jobId
  // stops working the moment the first copy completes. A day is far longer than
  // the window in which the relay can redeliver the same event.
  removeOnComplete: { age: 24 * 3600 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export function openQueue(connection: Redis): Queue<NotificationJob> {
  return new Queue<NotificationJob>(NOTIFICATIONS_QUEUE, { connection });
}

// The jobId is the outbox eventId. The relay delivers at least once, so the same
// event can be enqueued twice; the second add with the same id is a no-op, and
// the buyer gets one email.
export const orderPlacedJobId = (eventId: string): string => `order-placed-${eventId}`;

export function enqueueOrderPlaced(queue: Queue<NotificationJob>, job: OrderPlacedJob): Promise<Job<NotificationJob>> {
  return queue.add(ORDER_PLACED_JOB, job, { ...ORDER_PLACED_OPTIONS, jobId: orderPlacedJobId(job.eventId) });
}

// upsert, not add: a scheduler is identified by its id, so every restart of the
// process that calls this leaves exactly one scheduler behind, with the latest
// settings, instead of one more.
export function scheduleRatingsRecompute(queue: Queue<NotificationJob>, everyMs: number): Promise<unknown> {
  return queue.upsertJobScheduler(
    RECOMPUTE_RATINGS_SCHEDULER,
    { every: everyMs },
    { name: RECOMPUTE_RATINGS_JOB, data: {}, opts: { removeOnComplete: { count: 100 }, removeOnFail: { count: 100 } } },
  );
}

export interface Handlers {
  orderPlaced(job: Job<OrderPlacedJob>): Promise<void>;
  recomputeRatings(job: Job): Promise<void>;
}

// The worker's connection must be opened with maxRetriesPerRequest: null
// (connectRedis(..., { blocking: true })), or it breaks on the first Redis blip
// instead of waiting it out.
export function startWorker(connection: Redis, handlers: Handlers, concurrency = 4): Worker<NotificationJob> {
  return new Worker<NotificationJob>(
    NOTIFICATIONS_QUEUE,
    async (job) => {
      switch (job.name) {
        case ORDER_PLACED_JOB:
          return handlers.orderPlaced(job as Job<OrderPlacedJob>);
        case RECOMPUTE_RATINGS_JOB:
          return handlers.recomputeRatings(job);
        default:
          throw new Error(`unknown job ${job.name}`);
      }
    },
    { connection, concurrency },
  );
}
