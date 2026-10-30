import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { anAccount, loginAs, TestAccount } from '../testkit/auth';
import { testPool } from '../testkit/database';

// demo:reuse and demo:auth, as tests: the same sequences against the real module
// graph and the testcontainer, so the invariants are guarded on every run too.
describe('Auth end to end', () => {
  let app: INestApplication;
  let pool: Pool;
  let buyer: TestAccount;

  beforeAll(async () => {
    pool = testPool();
    buyer = await anAccount(pool, 'buyer');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = await configureApp(moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false }));
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  const refresh = (token: string) =>
    request(app.getHttpServer()).post('/auth/refresh').send({ refresh_token: token });

  it('revokes the whole family when a used refresh token comes back', async () => {
    const first = await loginAs(app, buyer);

    const rotated = await refresh(first.refresh_token).expect(200);
    await refresh(first.refresh_token).expect(401);
    await refresh(rotated.body.refresh_token).expect(401);
  });

  it('kills both tokens on logout', async () => {
    const pair = await loginAs(app, buyer);

    await request(app.getHttpServer()).get('/auth/me').auth(pair.access_token, { type: 'bearer' }).expect(200);
    await request(app.getHttpServer()).post('/auth/logout').auth(pair.access_token, { type: 'bearer' }).expect(204);

    const after = await request(app.getHttpServer())
      .get('/auth/me')
      .auth(pair.access_token, { type: 'bearer' })
      .expect(401);
    expect(after.headers['www-authenticate']).toMatch(/^Bearer/);
    await refresh(pair.refresh_token).expect(401);
  });

  it('answers 401 for a wrong password and for an unknown email alike', async () => {
    const wrong = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: buyer.email, password: 'not-the-password' })
      .expect(401);
    const unknown = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'nobody@example.test', password: 'whatever' })
      .expect(401);
    expect(unknown.body.detail).toBe(wrong.body.detail);
  });

  it('keeps 401 and 403 apart on a buyer writing a product', async () => {
    const { access_token } = await loginAs(app, buyer);
    const body = { title: 'Not mine to sell', price_cents: 100, currency: 'UAH' };

    await request(app.getHttpServer()).post('/products').set('Idempotency-Key', `e2e-${Date.now()}-anon`).send(body).expect(401);
    await request(app.getHttpServer())
      .post('/products')
      .auth(access_token, { type: 'bearer' })
      .set('Idempotency-Key', `e2e-${Date.now()}-buyer`)
      .send(body)
      .expect(403);
  });
});
