import { randomBytes } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { hashPassword } from '../../src/auth/password';
import { UserRole } from '../../src/entities/user.entity';
import { Queryable } from '../../src/repositories';
import { aUser } from './builders';

export interface TestAccount {
  id: string;
  email: string;
  password: string;
}

export interface Pair {
  access_token: string;
  refresh_token: string;
}

// A user who can log in: the builder's row plus a role and a scrypt hash.
export async function anAccount(db: Queryable, role: UserRole = 'buyer'): Promise<TestAccount> {
  const user = await aUser().create(db);
  const password = randomBytes(12).toString('base64url');
  await db.query(`UPDATE users SET role = $2, password_hash = $3 WHERE id = $1`, [
    user.id,
    role,
    await hashPassword(password),
  ]);
  return { id: user.id, email: user.email, password };
}

export async function loginAs(app: INestApplication, account: TestAccount): Promise<Pair> {
  const response = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email: account.email, password: account.password })
    .expect(200);
  return response.body as Pair;
}
