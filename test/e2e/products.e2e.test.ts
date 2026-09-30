import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';

import { ConfigService } from '@nestjs/config';

import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { connectionUri, testPool } from '../testkit/database';
import { aUser } from '../testkit/builders';

describe('Products end to end', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    // The environment was pointed at the testcontainer by setupFiles, before
    // app.module.ts was imported — see test/testkit/jest-setup-env.ts.
    pool = testPool();
    // POST /products attaches the catalogue entry to the first seller in the table
    await aUser().create(pool);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    // No overrideProvider anywhere: the real module graph, the real database, and
    // the same configureApp() main.ts uses — spec validation included.
    const nest = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    app = await configureApp(nest);

    // Guard: the application must be on the container this run started, not on
    // whatever .env happens to point at.
    const configured = new URL(nest.get(ConfigService).get<string>('DB_URL', ''));
    expect(configured.port).toBe(new URL(connectionUri()).port);
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it('creates a product and reads the same product back', async () => {
    const created = await request(app.getHttpServer())
      .post('/products')
      .set('Idempotency-Key', `e2e-${Date.now()}-create`)
      .send({ title: 'Mechanical keyboard', price_cents: 260_000, currency: 'UAH' })
      .expect(201);

    expect(created.body).toMatchObject({
      id: expect.stringMatching(/^p_\d+$/),
      title: 'Mechanical keyboard',
      price_cents: 260_000,
      currency: 'UAH',
    });

    const read = await request(app.getHttpServer())
      .get(`/products/${created.body.id}`)
      .expect(200);

    expect(read.body).toEqual(created.body);

    const page = await request(app.getHttpServer()).get('/products?limit=50').expect(200);
    expect(page.body.items.map((item: { id: string }) => item.id)).toContain(created.body.id);
  });

  it('replays the same idempotency key instead of creating a second product', async () => {
    const key = `e2e-${Date.now()}-replay`;
    const body = { title: 'Wireless mouse', price_cents: 89_900, currency: 'UAH' as const };

    const first = await request(app.getHttpServer())
      .post('/products')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);

    const replay = await request(app.getHttpServer())
      .post('/products')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);

    expect(replay.body.id).toBe(first.body.id);
    expect(replay.headers['idempotency-replay']).toBe('true');
  });

  it('answers 404 problem+json for a product that does not exist', async () => {
    const response = await request(app.getHttpServer()).get('/products/p_999999999').expect(404);

    expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(response.body).toMatchObject({
      status: 404,
      title: expect.any(String),
      detail: expect.stringContaining('p_999999999'),
      instance: '/products/p_999999999',
    });
  });

  it('answers 400 when the request does not match the published contract', async () => {
    const missingHeader = await request(app.getHttpServer())
      .post('/products')
      .send({ title: 'No key', price_cents: 1000, currency: 'UAH' })
      .expect(400);

    expect(missingHeader.body.status).toBe(400);

    await request(app.getHttpServer())
      .post('/products')
      .set('Idempotency-Key', `e2e-${Date.now()}-invalid`)
      .send({ title: '', price_cents: -5, currency: 'BTC' })
      .expect(400);
  });
});
