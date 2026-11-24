import { EntityManager } from 'typeorm';

import { DomainEvent } from '../messaging/events';
import { captureTraceContext } from '../observability/amqp-trace';
import { Queryable, fromEntityManager } from '../repositories/queryable';

export interface Aggregate {
  type: string;
  id: string;
}

// The event joins the transaction it describes: same manager, same connection,
// same COMMIT. Nothing here talks to the broker — a broker cannot roll back, so
// the only thing that may happen inside the transaction is a row in a table.
// The payload is the event contract as built by its to…Event() function, never an
// entity, so a column rename stays an internal matter.
export async function appendToOutbox(
  manager: EntityManager,
  aggregate: Aggregate,
  event: DomainEvent,
): Promise<void> {
  if (manager.queryRunner === undefined) {
    throw new Error('appendToOutbox() must be called inside the business transaction');
  }

  await appendToOutboxIn(fromEntityManager(manager), aggregate, event);
}

// The same row through any connection that is already inside the business
// transaction — a pg PoolClient between BEGIN and COMMIT, or fromEntityManager().
// The trace context of the work that wrote it rides along, so the relay's publish
// continues this trace instead of starting its own (observability/amqp-trace.ts).
export async function appendToOutboxIn(db: Queryable, aggregate: Aggregate, event: DomainEvent): Promise<void> {
  const traceContext = captureTraceContext();
  await db.query(
    `INSERT INTO outbox (id, aggregate_type, aggregate_id, type, payload, created_at, trace_context)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb)`,
    [
      event.eventId,
      aggregate.type,
      aggregate.id,
      event.type,
      JSON.stringify(event),
      event.occurredAt,
      traceContext === null ? null : JSON.stringify(traceContext),
    ],
  );
}
