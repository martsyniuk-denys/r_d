import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { ReadinessService } from '../../src/health/readiness.service';

// Liveness and readiness are two paths with two meanings: /healthz stays green for
// as long as the process turns, /readyz goes red the moment SIGTERM starts the drain
// (main.ts calls drain()), while the instance still answers everything else.
describe('Probes', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = await configureApp(moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false }));
  });

  afterAll(async () => {
    await app?.close();
  });

  it('is alive and ready while the database answers', async () => {
    await http().get('/healthz').expect(200, /"alive"/);
    const ready = await http().get('/readyz').expect(200);
    expect(ready.body).toMatchObject({ status: 'ready', checks: { database: 'up' } });
  });

  it('turns /readyz red on drain, keeps /healthz green and asks clients to reconnect elsewhere', async () => {
    app.get(ReadinessService).drain();

    const ready = await http().get('/readyz').expect(503);
    expect(ready.body.status).toBe('draining');
    expect(ready.headers.connection).toBe('close');

    await http().get('/healthz').expect(200);
    await http().get('/health').expect(200);
  });
});
