import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Order } from './order.entity';

export const JOB_STATUSES = ['pending', 'done', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

@Entity('jobs')
@Index('idx_jobs_pending', ['id'], { where: "status = 'pending'" })
@Check('jobs_status_known', "status IN ('pending', 'done', 'failed')")
@Check('jobs_processed_non_negative', 'processed >= 0')
export class Job {
  @PrimaryGeneratedColumn('identity', { type: 'bigint', generatedIdentity: 'ALWAYS' })
  id!: string;

  @Column('text')
  type!: string;

  @Column('jsonb', { default: () => "'{}'::jsonb" })
  payload!: Record<string, unknown>;

  @Column('text', { default: 'pending' })
  status!: JobStatus;

  @Column('integer', { default: 0 })
  processed!: number;

  @Column('integer', { default: 0 })
  attempts!: number;

  @Column('text', { name: 'processed_by', nullable: true })
  processedBy!: string | null;

  @Column('bigint', { name: 'order_id', nullable: true })
  orderId!: string | null;

  @ManyToOne(() => Order, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order!: Order | null;

  @Column('timestamptz', { name: 'created_at', default: () => 'now()' })
  createdAt!: Date;

  @Column('timestamptz', { name: 'processed_at', nullable: true })
  processedAt!: Date | null;
}
