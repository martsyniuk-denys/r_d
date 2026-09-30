import { Queryable } from './queryable';

export interface UserRecord {
  id: string;
  email: string;
  displayName: string;
  country: string;
  balanceMinor: number;
  createdAt: Date;
}

export interface NewUser {
  email: string;
  displayName: string;
  country: string;
  balanceMinor?: number;
}

interface Row {
  id: string;
  email: string;
  display_name: string;
  country: string;
  balance_minor: number;
  created_at: Date;
}

const COLUMNS = 'id, email, display_name, country, balance_minor, created_at';

const toRecord = (row: Row): UserRecord => ({
  id: row.id,
  email: row.email,
  displayName: row.display_name,
  country: row.country,
  balanceMinor: row.balance_minor,
  createdAt: row.created_at,
});

export class UsersRepository {
  constructor(private readonly db: Queryable) {}

  async insert(input: NewUser): Promise<UserRecord> {
    const { rows } = await this.db.query<Row>(
      `INSERT INTO users (email, display_name, country, balance_minor)
       VALUES ($1, $2, $3, $4)
       RETURNING ${COLUMNS}`,
      [input.email, input.displayName, input.country, input.balanceMinor ?? 0],
    );
    return toRecord(rows[0]);
  }

  async findById(id: string): Promise<UserRecord | null> {
    const { rows } = await this.db.query<Row>(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [id]);
    return rows.length === 0 ? null : toRecord(rows[0]);
  }

  // Matched case-insensitively through idx_users_email_lower, the way the
  // data-layer homework indexed it.
  async findByEmail(email: string): Promise<UserRecord | null> {
    const { rows } = await this.db.query<Row>(
      `SELECT ${COLUMNS} FROM users WHERE lower(email) = lower($1)`,
      [email],
    );
    return rows.length === 0 ? null : toRecord(rows[0]);
  }

  async firstId(): Promise<string | null> {
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id FROM users ORDER BY id LIMIT 1`,
    );
    return rows.length === 0 ? null : rows[0].id;
  }
}
