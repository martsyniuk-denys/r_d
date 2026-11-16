import { join } from 'node:path';

import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import express, { NextFunction, Request, Response } from 'express';
import * as OpenApiValidator from 'express-openapi-validator';

import { AppModule } from './app.module';
import { ProblemFilter } from './common/problem.filter';
import { toProblem } from './common/problem';
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
  app.getHttpAdapter().getInstance().get('/metrics', metricsEndpoint);

  // The order is the point: the request's store first, then the observer (so a
  // 400 from the body parser is still counted and logged), then the parser.
  app.use(requestContext());
  app.use(observeRequests());
  app.use(express.json());

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

  const server = app.getHttpAdapter().getInstance();
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
