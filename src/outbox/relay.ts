import { DataSource } from 'typeorm';

import { EventPublisher } from '../messaging/publisher';

export const RELAY_BATCH = 50;

interface OutboxRow {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

export interface RelayBatch {
  picked: number;
  published: string[];
  failed: { id: string; reason: string }[];
}

export interface RelayHooks {
  onPublished?: (id: string) => void;
  // Runs after every publish of the batch has been confirmed and before the
  // UPDATE that marks them. demo:crash-relay holds the process here and kills it.
  beforeMark?: (published: string[]) => Promise<void>;
}

// One pass of the polling relay, in one transaction on one connection:
//
//   1. SELECT … WHERE published_at IS NULL … FOR UPDATE SKIP LOCKED LIMIT n
//   2. publish each row, waiting for the broker's confirm
//   3. UPDATE … SET published_at = now()
//
// SKIP LOCKED, not a bare FOR UPDATE: a second relay skips the rows this one holds
// and takes the next ones, instead of queueing behind the lock. It is
// published_at IS NULL and not "id > last seen" that finds the work: a row becomes
// visible at its COMMIT, not in the order its key was drawn, so a cursor would
// step over a row that committed late.
//
// 2 before 3, never the other way round. Die between them and the row is still
// unpublished, and the next pass publishes it again: a duplicate, which the
// consumer's inbox absorbs. Mark first and die before the publish, and the row
// says "published" about an event nobody ever received: a loss, which nothing
// downstream can detect. And a failed publish is not proof that nothing was
// delivered — the confirm can be what got lost — so that row is retried too.
export async function relayBatch(
  dataSource: DataSource,
  publisher: EventPublisher,
  hooks: RelayHooks = {},
  limit = RELAY_BATCH,
): Promise<RelayBatch> {
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();

  try {
    const rows: OutboxRow[] = await runner.query(
      `SELECT id, type, payload, created_at
         FROM outbox
        WHERE published_at IS NULL
        ORDER BY created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT $1`,
      [limit],
    );

    const outcomes = await Promise.allSettled(
      rows.map(async (row) => {
        await publisher.publishRaw(row.type, Buffer.from(JSON.stringify(row.payload)), {
          messageId: row.id,
          type: row.type,
          timestamp: Math.floor(new Date(row.created_at).getTime() / 1000),
        });
        hooks.onPublished?.(row.id);
      }),
    );

    const published: string[] = [];
    const failed: { id: string; reason: string }[] = [];
    outcomes.forEach((outcome, i) => {
      if (outcome.status === 'fulfilled') published.push(rows[i].id);
      else failed.push({ id: rows[i].id, reason: String((outcome.reason as Error)?.message ?? outcome.reason) });
    });

    if (hooks.beforeMark !== undefined && published.length > 0) await hooks.beforeMark(published);

    if (published.length > 0) {
      await runner.query(
        `UPDATE outbox SET published_at = now(), attempts = attempts + 1 WHERE id = ANY($1::uuid[])`,
        [published],
      );
    }
    // Still unpublished, so the next pass picks it up again; attempts is what an
    // alert on a stuck row would watch.
    if (failed.length > 0) {
      await runner.query(`UPDATE outbox SET attempts = attempts + 1 WHERE id = ANY($1::uuid[])`, [
        failed.map((f) => f.id),
      ]);
    }

    await runner.commitTransaction();
    return { picked: rows.length, published, failed };
  } catch (error) {
    await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
  }
}
