import { Column, Entity, PrimaryColumn } from 'typeorm';

// The consumer's inbox: "this consumer has handled this message". Written in the
// same transaction as the effect, so the mark and the effect commit or vanish
// together. The key is the pair — two different consumers of one event each
// process it once.
@Entity('processed_messages')
export class ProcessedMessage {
  @PrimaryColumn('text', { name: 'message_id' })
  messageId!: string;

  @PrimaryColumn('text')
  consumer!: string;

  @Column('timestamptz', { name: 'processed_at', default: () => 'now()' })
  processedAt!: Date;
}
