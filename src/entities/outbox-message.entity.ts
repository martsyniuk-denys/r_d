import { Check, Column, Entity, Index, PrimaryColumn } from 'typeorm';

// One row per event the business operation decided to emit, written in the same
// transaction as the business rows. The column roles are the ones the Debezium
// Outbox Event Router reads (id, aggregatetype, aggregateid, type, payload), so a
// later move from the polling relay to CDC changes the config, not the consumers;
// the snake_case names are mapped explicitly there (see the README).
@Entity('outbox')
// The relay's only query: the unpublished rows, oldest first. Partial, so it holds
// the backlog and not the history — published rows fall out of it.
@Index('idx_outbox_unpublished', ['createdAt', 'id'], { where: 'published_at IS NULL' })
@Check('outbox_attempts_non_negative', 'attempts >= 0')
export class OutboxMessage {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('text', { name: 'aggregate_type' })
  aggregateType!: string;

  @Column('text', { name: 'aggregate_id' })
  aggregateId!: string;

  @Column('text')
  type!: string;

  @Column('jsonb')
  payload!: Record<string, unknown>;

  @Column('timestamptz', { name: 'created_at', default: () => 'now()' })
  createdAt!: Date;

  @Column('timestamptz', { name: 'published_at', nullable: true })
  publishedAt!: Date | null;

  @Column('integer', { default: 0 })
  attempts!: number;
}
