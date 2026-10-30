import { Check, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';

import { User } from './user.entity';

export const FILE_STATUSES = ['PENDING', 'COMPLETED'] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

// The list of a user's files lives here, not in the bucket: listing a bucket is
// paid, slow (1 000 keys a call) and knows nothing about owners. A row is born
// PENDING at the intent and becomes COMPLETED only after HeadObject has seen the
// object; a PENDING row older than a day is an abandoned upload to clean up.
@Entity('files')
@Index('files_key_unique', ['key'], { unique: true })
@Index('idx_files_owner_created_at', ['ownerId', 'createdAt'])
@Index('idx_files_pending_created_at', ['createdAt'], { where: "status = 'PENDING'" })
@Check('files_status_known', "status IN ('PENDING', 'COMPLETED')")
@Check('files_size_positive', 'size > 0')
export class StoredFile {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('text')
  key!: string;

  @Column('bigint', { name: 'owner_id' })
  ownerId!: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'owner_id' })
  owner!: User;

  @Column('text', { default: 'PENDING' })
  status!: FileStatus;

  @Column('text', { name: 'content_type' })
  contentType!: string;

  // Declared at the intent, checked against HeadObject at the commit.
  @Column('bigint')
  size!: string;

  // Set for a multipart upload only.
  @Column('text', { name: 'upload_id', nullable: true })
  uploadId!: string | null;

  @Column('integer', { name: 'part_size', nullable: true })
  partSize!: number | null;

  @Column('integer', { name: 'part_count', nullable: true })
  partCount!: number | null;

  @Column('timestamptz', { name: 'created_at', default: () => 'now()' })
  createdAt!: Date;

  @Column('timestamptz', { name: 'completed_at', nullable: true })
  completedAt!: Date | null;
}
