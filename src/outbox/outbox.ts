import { EntityManager } from 'typeorm';

import { DomainEvent } from '../messaging/events';

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

  await manager.query(
    `INSERT INTO outbox (id, aggregate_type, aggregate_id, type, payload, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [event.eventId, aggregate.type, aggregate.id, event.type, JSON.stringify(event), event.occurredAt],
  );
}
