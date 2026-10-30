import { createHmac, randomBytes, randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { Pool, PoolClient } from 'pg';

import { unauthorized } from '../common/problem';
import { Env } from '../config/env.schema';
import { PG_POOL } from '../db/database.module';
import { USER_ROLES, UserRole } from '../entities/user.entity';
import { ALGORITHM, KeyRing } from './keys';
import { verifyPassword } from './password';
import { Principal } from './principal';

export interface TokenPair {
  token_type: 'Bearer';
  access_token: string;
  expires_in: number;
  refresh_token: string;
  refresh_expires_in: number;
}

interface Account {
  id: string;
  role: UserRole;
}

type Exchange =
  | { kind: 'unknown' | 'expired' }
  | { kind: 'revoked'; familyId: string }
  | { kind: 'reuse'; familyId: string; tokenId: string; userId: string; revoked: number }
  | { kind: 'rotated'; account: Account; familyId: string; refreshToken: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every failure below is the same 401 with the same words. Which of them it was
// goes to the log (by jti / family id, never the token), not to the caller.
const INVALID_TOKEN = 'The access token is missing, expired, revoked or invalid.';
const INVALID_REFRESH = 'The refresh token is unknown, expired or revoked. Log in again.';

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger('auth');
  private readonly keys: KeyRing;
  private readonly pepper: string;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly accessTtl: number;
  private readonly refreshTtl: number;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    config: ConfigService<Env, true>,
  ) {
    this.keys = KeyRing.fromConfig(config);
    this.pepper = config.get('REFRESH_TOKEN_PEPPER', { infer: true });
    this.issuer = config.get('JWT_ISSUER', { infer: true });
    this.audience = config.get('JWT_AUDIENCE', { infer: true });
    this.accessTtl = config.get('JWT_ACCESS_TTL_SECONDS', { infer: true });
    this.refreshTtl = config.get('REFRESH_TTL_SECONDS', { infer: true });
  }

  onModuleInit(): void {
    this.logger.log(`${ALGORITHM} keys: ${this.keys.describe()}`);
  }

  async login(email: string, password: string): Promise<TokenPair> {
    const { rows } = await this.pool.query<{ id: string; role: UserRole; password_hash: string | null }>(
      `SELECT id, role, password_hash FROM users WHERE lower(email) = lower($1)`,
      [email],
    );
    const user = rows[0];

    // verifyPassword runs on a dummy hash for an unknown email: both refusals cost the same.
    if (!(await verifyPassword(password, user?.password_hash ?? null)) || user === undefined) {
      throw unauthorized('Invalid email or password.');
    }

    const familyId = randomUUID();
    const refreshToken = await this.issueRefresh(this.pool, user.id, familyId, null);
    this.logger.log(`login user=${user.id} family=${familyId}`);
    return this.pair({ id: user.id, role: user.role }, familyId, refreshToken);
  }

  // Rotation with reuse detection, in one transaction. The row is locked, so two
  // exchanges of one token are serialised: the first rotates it, the second finds
  // used_at set — and that is the compromise signal (RFC 9700 §4.14.2): one of the
  // two presenters is not the client the token was issued to, and there is no way
  // to tell which, so the whole family goes. The revocation is COMMITted before the
  // 401 is thrown; throwing inside the transaction would roll it back.
  async refresh(token: string): Promise<TokenPair> {
    const outcome = await this.transaction<Exchange>(async (db) => {
      const { rows } = await db.query<{
        id: string;
        user_id: string;
        family_id: string;
        used_at: Date | null;
        revoked_at: Date | null;
        expired: boolean;
        role: UserRole;
      }>(
        `SELECT r.id, r.user_id, r.family_id, r.used_at, r.revoked_at, r.expires_at <= now() AS expired, u.role
           FROM refresh_tokens r
           JOIN users u ON u.id = r.user_id
          WHERE r.token_hash = $1
            FOR UPDATE OF r`,
        [this.hash(token)],
      );
      const row = rows[0];

      if (row === undefined) return { kind: 'unknown' };
      if (row.revoked_at !== null) return { kind: 'revoked', familyId: row.family_id };

      if (row.used_at !== null) {
        const revoked = await this.revokeFamily(db, row.family_id);
        return { kind: 'reuse', familyId: row.family_id, tokenId: row.id, userId: row.user_id, revoked };
      }

      if (row.expired) return { kind: 'expired' };

      await db.query(`UPDATE refresh_tokens SET used_at = now() WHERE id = $1`, [row.id]);
      const refreshToken = await this.issueRefresh(db, row.user_id, row.family_id, row.id);
      // The role is read again here, from users: a refresh is where a changed role
      // reaches the next access token.
      return { kind: 'rotated', account: { id: row.user_id, role: row.role }, familyId: row.family_id, refreshToken };
    });

    switch (outcome.kind) {
      case 'rotated':
        return this.pair(outcome.account, outcome.familyId, outcome.refreshToken);
      case 'reuse':
        this.logger.warn(
          `refresh token reuse detected: token=${outcome.tokenId} family=${outcome.familyId} ` +
            `user=${outcome.userId} — family revoked (${outcome.revoked} live token(s))`,
        );
        throw unauthorized(INVALID_REFRESH);
      case 'revoked':
        this.logger.log(`refresh refused: family=${outcome.familyId} is revoked`);
        throw unauthorized(INVALID_REFRESH);
      default:
        throw unauthorized(INVALID_REFRESH);
    }
  }

  // Logout is two writes, one COMMIT: the refresh family is revoked (a row the
  // server owns, so marking it is enough), and the access token's jti goes on the
  // denylist until its exp (a self-contained token the server cannot mark — it
  // stays valid until exp unless every request asks the denylist). Both live in
  // Postgres, so there is no second store to fall out of step with.
  async logout(principal: Principal): Promise<void> {
    await this.transaction(async (db) => {
      await this.revokeFamily(db, principal.familyId);
      await db.query(
        `INSERT INTO revoked_access_tokens (jti, expires_at) VALUES ($1, to_timestamp($2))
         ON CONFLICT (jti) DO NOTHING`,
        [principal.jti, principal.expiresAt],
      );
      // The denylist forgets on its own: a row is useless once the token it names
      // has expired, so every logout sweeps those away.
      await db.query(`DELETE FROM revoked_access_tokens WHERE expires_at <= now()`);
    });
    this.logger.log(`logout user=${principal.userId} family=${principal.familyId} jti=${principal.jti}`);
  }

  // jwt.verify, not jwt.decode: the signature, exp, iss and aud are all checked,
  // with the algorithm taken from the allowlist and never from the token. The
  // header is read unverified only to pick a key by kid; an unknown kid is a 401.
  async verifyAccess(token: string): Promise<Principal> {
    const header = jwt.decode(token, { complete: true })?.header;
    const key = this.keys.verifierFor(header?.kid);
    if (key === undefined) throw unauthorized(INVALID_TOKEN);

    let claims: JwtPayload;
    try {
      claims = jwt.verify(token, key, {
        algorithms: [ALGORITHM],
        issuer: this.issuer,
        audience: this.audience,
      }) as JwtPayload;
    } catch {
      throw unauthorized(INVALID_TOKEN);
    }

    const { sub, role, jti, sid, exp } = claims;
    if (
      typeof sub !== 'string' ||
      !USER_ROLES.includes(role) ||
      typeof jti !== 'string' ||
      !UUID.test(jti) ||
      typeof sid !== 'string' ||
      !UUID.test(sid) ||
      typeof exp !== 'number'
    ) {
      throw unauthorized(INVALID_TOKEN);
    }

    // exp is the library's job; revocation is ours.
    const { rowCount } = await this.pool.query(
      `SELECT 1 FROM revoked_access_tokens WHERE jti = $1 AND expires_at > now()`,
      [jti],
    );
    if (rowCount !== 0) throw unauthorized(INVALID_TOKEN);

    return { userId: sub, role, jti, familyId: sid, expiresAt: exp };
  }

  private pair(account: Account, familyId: string, refreshToken: string): TokenPair {
    const accessToken = jwt.sign({ role: account.role, sid: familyId }, this.keys.privateKey, {
      algorithm: ALGORITHM,
      keyid: this.keys.kid,
      expiresIn: this.accessTtl,
      issuer: this.issuer,
      audience: this.audience,
      subject: account.id,
      jwtid: randomUUID(),
    });

    return {
      token_type: 'Bearer',
      access_token: accessToken,
      expires_in: this.accessTtl,
      refresh_token: refreshToken,
      refresh_expires_in: this.refreshTtl,
    };
  }

  // 256 random bits, opaque: not a JWT, nothing to decode, only to look up. The
  // table keeps HMAC(pepper, token) — the pepper lives in the store, not in the
  // database, so a leaked table alone cannot be turned back into sessions.
  private async issueRefresh(
    db: Pool | PoolClient,
    userId: string,
    familyId: string,
    parentId: string | null,
  ): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await db.query(
      `INSERT INTO refresh_tokens (id, user_id, family_id, parent_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))`,
      [randomUUID(), userId, familyId, parentId, this.hash(token), this.refreshTtl],
    );
    return token;
  }

  private async revokeFamily(db: PoolClient, familyId: string): Promise<number> {
    const { rowCount } = await db.query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`,
      [familyId],
    );
    return rowCount ?? 0;
  }

  private hash(token: string): string {
    return createHmac('sha256', this.pepper).update(token).digest('hex');
  }

  private async transaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
