import { join } from 'node:path';

import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import express, { NextFunction, Request, Response } from 'express';
import * as OpenApiValidator from 'express-openapi-validator';

import { AppModule } from './app.module';
import { ProblemFilter } from './common/problem.filter';
import { toProblem } from './common/problem';

export const API_SPEC = join(__dirname, '..', 'openapi', 'openapi.yaml');

export async function createApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    abortOnError: false,
  });
  app.disable('x-powered-by');

  app.use(express.json());

  app.use(
    OpenApiValidator.middleware({
      apiSpec: API_SPEC,
      validateRequests: true,
      validateResponses: true,
      validateApiSpec: true,
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
