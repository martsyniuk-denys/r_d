import { join } from 'node:path';

import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import express, { NextFunction, Request, Response } from 'express';
import * as OpenApiValidator from 'express-openapi-validator';

import { AppModule } from './app.module';
import { ProblemFilter } from './common/problem.filter';
import { toProblem } from './common/problem';

/** The spec lives next to dist/, so this resolves from the compiled output too. */
export const API_SPEC = join(__dirname, '..', 'openapi', 'openapi.yaml');

/**
 * Builds the application without listening, so tests and `main.ts` share one
 * wiring. The middleware order is the whole point of option B:
 *
 *   express.json()  →  OpenApiValidator  →  Nest router  →  problem+json
 *
 * Nest's own body parser is switched off: it is registered during `app.init()`,
 * which runs after our `app.use()` calls, so the validator would otherwise see
 * an unparsed body.
 */
export async function createApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.disable('x-powered-by');

  app.use(express.json());

  // The boundary: nothing that contradicts openapi.yaml gets through.
  // validateRequests  — rejects invalid requests (a missing Idempotency-Key included);
  // validateResponses — stops the app from serving anything the spec does not describe.
  app.use(
    OpenApiValidator.middleware({
      apiSpec: API_SPEC,
      validateRequests: true,
      validateResponses: true,
      validateApiSpec: true,
    }),
  );

  // Catches everything raised inside Nest: controllers, services, and the
  // response validator that fires when a handler drifts from the spec.
  app.useGlobalFilters(new ProblemFilter());

  await app.init();

  // The validator rejects requests before Nest's pipeline runs, so its errors
  // never reach the exception filter above — they surface as Express errors and
  // need a handler registered after Nest has mounted its router.
  const server = app.getHttpAdapter().getInstance();
  server.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const problem = toProblem(err, req);
    res.status(problem.status).type('application/problem+json').json(problem);
  });

  return app;
}
