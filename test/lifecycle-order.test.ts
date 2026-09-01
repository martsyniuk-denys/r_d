import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { z } from 'zod';

import { Controller } from '../src/decorators/controller';
import { Post } from '../src/decorators/methods';
import { Body } from '../src/decorators/params';
import type {
  CallHandler,
  CanActivate,
  ExceptionFilter,
  ExecutionContext,
  Interceptor,
  Middleware,
  PipeTransform,
} from '../src/lifecycle';
import { HttpExceptionFilter } from '../src/filters/exception.filter';
import { AUTH, startApp, type TestApp } from './support/app';

const calls: string[] = [];

class RecordingMiddleware implements Middleware {
  async use(_context: ExecutionContext, next: () => Promise<void>): Promise<void> {
    calls.push('middleware');
    await next();
  }
}

class RecordingGuard implements CanActivate {
  canActivate(): boolean {
    calls.push('guard');
    return true;
  }
}

class RecordingInterceptor implements Interceptor {
  async intercept(_context: ExecutionContext, next: CallHandler): Promise<unknown> {
    calls.push('interceptor:before');
    const result = await next();
    calls.push('interceptor:after');
    return result;
  }
}

class RecordingPipe implements PipeTransform {
  transform(value: unknown): unknown {
    calls.push('pipe');
    return value;
  }
}

class RecordingFilter implements ExceptionFilter {
  private readonly inner = new HttpExceptionFilter(() => {});

  catch(error: unknown, context: ExecutionContext): void {
    calls.push('filter');
    this.inner.catch(error, context);
  }
}

const schema = z.object({ ping: z.string() });

@Controller('order')
class OrderController {
  @Post()
  create(@Body(schema) body: { ping: string }): unknown {
    calls.push('handler');
    return body;
  }

  @Post('boom')
  boom(@Body(schema) _body: { ping: string }): never {
    calls.push('handler');
    throw new Error('boom');
  }
}

let app: TestApp;

before(async () => {
  app = await startApp([OrderController], {
    middleware: [new RecordingMiddleware()],
    guards: [new RecordingGuard()],
    interceptors: [new RecordingInterceptor()],
    pipes: [new RecordingPipe()],
    filter: new RecordingFilter(),
  });
});

after(async () => {
  await app.close();
});

async function post(path: string): Promise<Response> {
  calls.length = 0;

  return fetch(`${app.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...AUTH },
    body: JSON.stringify({ ping: 'pong' }),
  });
}

describe('request lifecycle order', () => {
  it('runs the six stages in exactly this order', async () => {
    const response = await post('/order');

    assert.equal(response.status, 201);
    assert.deepEqual(calls, [
      'middleware',
      'guard',
      'interceptor:before',
      'pipe',
      'handler',
      'interceptor:after',
    ]);
  });

  it('puts the exception filter last, after the stage that threw', async () => {
    const response = await post('/order/boom');

    assert.equal(response.status, 500);
    assert.deepEqual(calls, ['middleware', 'guard', 'interceptor:before', 'pipe', 'handler', 'filter']);
    assert.equal(calls.at(-1), 'filter');
  });

  it('skips guard, pipes and handler when no route matches', async () => {
    calls.length = 0;

    const response = await fetch(`${app.url}/order/nope`, { method: 'POST' });

    assert.equal(response.status, 404);
    assert.deepEqual(calls, ['middleware', 'filter']);
  });
});
