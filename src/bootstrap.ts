import { join } from 'node:path';

import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import express, { NextFunction, Request, Response } from 'express';
import * as OpenApiValidator from 'express-openapi-validator';

import { AppModule } from './app.module';
import { ProblemFilter } from './common/problem.filter';
import { toProblem } from './common/problem';
import { ReadinessService } from './health/readiness.service';
import { requestContext } from './observability/context';
import { NestPinoLogger } from './observability/nest-logger';
import { metricsEndpoint, observeRequests } from './observability/request-log';

export const API_SPEC = join(__dirname, '..', 'openapi', 'openapi.yaml');

// Everything that turns a bare Nest application into this application. Both
// main.ts and the end-to-end suite go through here, so the tests cannot end up
// exercising a differently wired app than production.
export async function configureApp(app: NestExpressApplication): Promise<NestExpressApplication> {
  app.disable('x-powered-by');

  // Prometheus' scrape: registered before everything else, so it is neither
  // counted, logged nor validated against the contract.
  const server = app.getHttpAdapter().getInstance();
  server.get('/metrics', metricsEndpoint);

  // The probes, for the same reason: they arrive every few seconds from compose or
  // the kubelet, and a log line per probe would bury the requests. While draining,
  // every response says "Connection: close", so keep-alive clients reconnect to
  // another instance instead of to a socket that is about to close.
  const readiness = app.get(ReadinessService);
  server.use((_req: Request, res: Response, next: NextFunction) => {
    if (readiness.draining) res.setHeader('Connection', 'close');
    next();
  });
  server.get('/healthz', (_req: Request, res: Response) => {
    res.json({ status: 'alive', uptime_seconds: Math.round(process.uptime() * 1000) / 1000 });
  });
  server.get('/readyz', (_req: Request, res: Response) => {
    void readiness.check().then((result) => res.status(result.status === 'ready' ? 200 : 503).json(result));
  });

  // The order is the point: the request's store first, then the observer (so a
  // 400 from the body parser is still counted and logged), then the parser.
  app.use(requestContext());
  app.use(observeRequests());
  // The raw bytes are kept for the one route that must see them: a webhook's HMAC
  // is over the body as sent, and JSON.stringify(req.body) is not those bytes.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );

  app.use(
    OpenApiValidator.middleware({
      apiSpec: API_SPEC,
      validateRequests: true,
      validateResponses: true,
      validateApiSpec: true,
      // Authentication is the guards' job, not the validator's: one place decides
      // 401 vs 403, and a missing header is not answered differently from a bad token.
      validateSecurity: false,
    }),
  );

  app.useGlobalFilters(new ProblemFilter());

  await app.init();

  server.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const problem = toProblem(err, req);
    res.status(problem.status).type('application/problem+json').json(problem);
  });

  return app;
}

export async function createApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    abortOnError: false,
    logger: new NestPinoLogger(),
  });

  return configureApp(app);
}
