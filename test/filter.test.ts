import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { z } from 'zod';

import { Controller } from '../src/decorators/controller';
import { Get, Post } from '../src/decorators/methods';
import { Body } from '../src/decorators/params';
import { HttpError, NotFoundError, ValidationError } from '../src/errors';
import type { CallHandler, ExecutionContext, Interceptor, Middleware } from '../src/lifecycle';
import { RequestIdMiddleware } from '../src/middleware/request-id.middleware';
import { startApp, type TestApp } from './support/app';

class ThrowingInterceptor implements Interceptor {
  async intercept(context: ExecutionContext, next: CallHandler): Promise<unknown> {
    if (context.path === '/failures/from-interceptor') {
      throw new NotFoundError('interceptor says this is gone');
    }

    return next();
  }
}

class ThrowingMiddleware implements Middleware {
  async use(context: ExecutionContext, next: () => Promise<void>): Promise<void> {
    if (context.path === '/failures/from-middleware') {
      throw new Error('boom in middleware');
    }

    await next();
  }
}

@Controller('failures')
class FailuresController {
  @Get('missing')
  missing(): never {
    throw new NotFoundError('User 999 not found');
  }

  @Get('boom')
  boom(): never {
    throw new Error('boom');
  }

  @Get('teapot')
  teapot(): never {
    throw new HttpError(418, 'I am a teapot');
  }

  @Get('rejected')
  async rejected(): Promise<never> {
    throw new ValidationError([{ field: 'age', constraints: ['age must be a number'] }]);
  }

  @Post('body')
  body(@Body(z.object({ ok: z.boolean() })) value: unknown): unknown {
    return value;
  }

  @Get('from-interceptor')
  unreachable(): string {
    return 'never';
  }

  @Get('from-middleware')
  alsoUnreachable(): string {
    return 'never';
  }
}

let app: TestApp;

before(async () => {
  app = await startApp([FailuresController], {
    middleware: [new RequestIdMiddleware(), new ThrowingMiddleware()],
    interceptors: [new ThrowingInterceptor()],
  });
});

after(async () => {
  await app.close();
});

describe('HttpExceptionFilter', () => {
  it('maps NotFoundError to 404 with the domain message', async () => {
    const response = await fetch(`${app.url}/failures/missing`);
    const body = (await response.json()) as { statusCode: number; message: string };

    assert.equal(response.status, 404);
    assert.equal(body.statusCode, 404);
    assert.equal(body.message, 'User 999 not found');
  });

  it('maps ValidationError to 400 with the list of fields', async () => {
    const response = await fetch(`${app.url}/failures/rejected`);
    const body = (await response.json()) as {
      statusCode: number;
      errors: { field: string; constraints: string[] }[];
    };

    assert.equal(response.status, 400);
    assert.deepEqual(body.errors, [{ field: 'age', constraints: ['age must be a number'] }]);
  });

  it('turns an unexpected error into 500 without leaking the message or a stack', async () => {
    const response = await fetch(`${app.url}/failures/boom`);
    const text = await response.text();

    assert.equal(response.status, 500);
    assert.equal((JSON.parse(text) as { message: string }).message, 'Internal server error');
    assert.doesNotMatch(text, /boom|at .*\.ts:/);
    assert.doesNotMatch(text, /stack/i);
  });

  it('keeps the status a transport error already carries', async () => {
    const response = await fetch(`${app.url}/failures/teapot`);

    assert.equal(response.status, 418);
    assert.equal(((await response.json()) as { message: string }).message, 'I am a teapot');
  });

  it('catches what an interceptor throws, not only the handler', async () => {
    const response = await fetch(`${app.url}/failures/from-interceptor`);

    assert.equal(response.status, 404);
    assert.match(((await response.json()) as { message: string }).message, /interceptor says/);
  });

  it('catches what a middleware throws, before any route was even matched', async () => {
    const response = await fetch(`${app.url}/failures/from-middleware`);
    const text = await response.text();

    assert.equal(response.status, 500);
    assert.doesNotMatch(text, /boom/);
  });

  it('puts the request id on every error response, body and header alike', async () => {
    const response = await fetch(`${app.url}/failures/missing`, {
      headers: { 'x-request-id': 'trace-error' },
    });

    assert.equal(response.headers.get('x-request-id'), 'trace-error');
    assert.equal(((await response.json()) as { requestId: string }).requestId, 'trace-error');
  });

  it('answers 400 for a malformed JSON body and 404 for an unknown route', async () => {
    const malformed = await fetch(`${app.url}/failures/body`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });
    const unknown = await fetch(`${app.url}/nowhere`);

    assert.equal(malformed.status, 400);
    assert.equal(unknown.status, 404);
    assert.match(((await unknown.json()) as { message: string }).message, /Cannot GET \/nowhere/);
  });
});
