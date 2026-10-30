import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';

import { User } from './user.entity';

// One row per refresh token ever issued. The token itself is never stored: only
// HMAC-SHA256(pepper, token), so a dump of this table is not a dump of live
// sessions. Every token of one login shares family_id; parent_id links a token to
// the one it was rotated from — kept so that a replayed token has a family to revoke.
@Entity('refresh_tokens')
@Index('refresh_tokens_token_hash_unique', ['tokenHash'], { unique: true })
@Index('idx_refresh_tokens_family', ['familyId'])
export class RefreshToken {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('bigint', { name: 'user_id' })
  userId!: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column('uuid', { name: 'family_id' })
  familyId!: string;

  @Column('uuid', { name: 'parent_id', nullable: true })
  parentId!: string | null;

  @ManyToOne(() => RefreshToken, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'parent_id' })
  parent!: RefreshToken | null;

  @Column('text', { name: 'token_hash' })
  tokenHash!: string;

  @Column('timestamptz', { name: 'issued_at', default: () => 'now()' })
  issuedAt!: Date;

  @Column('timestamptz', { name: 'expires_at' })
  expiresAt!: Date;

  // Set when the token is exchanged. A second exchange of the same token is the
  // reuse signal.
  @Column('timestamptz', { name: 'used_at', nullable: true })
  usedAt!: Date | null;

  // Set on every token of the family at once: logout, or a detected reuse.
  @Column('timestamptz', { name: 'revoked_at', nullable: true })
  revokedAt!: Date | null;
}
