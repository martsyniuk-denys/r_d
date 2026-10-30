import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

// The access-token denylist. A row lives exactly as long as the token it names:
// expires_at is the token's exp, lookups ignore expired rows and every logout
// deletes them, so the table holds at most one access-TTL worth of logouts.
@Entity('revoked_access_tokens')
@Index('idx_revoked_access_tokens_expires_at', ['expiresAt'])
export class RevokedAccessToken {
  @PrimaryColumn('uuid')
  jti!: string;

  @Column('timestamptz', { name: 'expires_at' })
  expiresAt!: Date;
}
