import 'reflect-metadata';

import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Controller } from '../src/decorators/controller';
import { Get } from '../src/decorators/methods';
import { LoggingInterceptor } from '../src/interceptors/logging.interceptor';
import type { CallHandler, ExecutionContext, Interceptor } from '../src/lifecycle';
import { startApp, type TestApp } from './support/app';

const lines: string[] = [];

class EnvelopeInterceptor implements Interceptor {
  async intercept(_context: ExecutionContext, next: CallHandler): Promise<unknown> {
    return { data: await next() };
  }
}

@Controller('slow')
class SlowController {
  @Get()
  async read(): Promise<{ ok: boolean }> {
    await delay(15);
    return { ok: true };
  }

  @Get('boom')
  fail(): never {
    throw new Error('boom');
  }
}

let app: TestApp;

before(async () => {
  app = await startApp([SlowController], {
    interceptors: [new LoggingInterceptor((line) => lines.push(line)), new EnvelopeInterceptor()],
  });
});

after(async () => {
  await app.close();
});

beforeEach(() => {
  lines.length = 0;
});

describe('LoggingInterceptor', () => {
  it('logs the route and a duration in milliseconds', async () => {
    await fetch(`${app.url}/slow`);

    assert.equal(lines.length, 1);
    assert.match(lines[0] as string, /GET \/slow/);
    assert.match(lines[0] as string, /[0-9]+(\.[0-9]+)? ?ms/);
  });

  it('measures the real duration of the handler, not zero', async () => {
    await fetch(`${app.url}/slow`);

    const measured = Number(/([0-9]+\.[0-9]+) ms/.exec(lines[0] as string)?.[1]);

    assert.ok(measured >= 15, `expected at least 15 ms, logged ${measured}`);
  });

  it('carries the request id, read from the store rather than passed in', async () => {
    await fetch(`${app.url}/slow`, { headers: { 'x-request-id': 'trace-interceptor' } });

    assert.match(lines[0] as string, /^\[trace-interceptor\] GET \/slow/);
  });

  it('still logs a duration when the handler throws', async () => {
    const response = await fetch(`${app.url}/slow/boom`);

    assert.equal(response.status, 500);
    assert.equal(lines.length, 1);
    assert.match(lines[0] as string, /GET \/slow\/boom — [0-9]+(\.[0-9]+)? ms/);
  });

  it('sees the handler result on the way out and can replace it', async () => {
    const response = await fetch(`${app.url}/slow`);

    assert.deepEqual(await response.json(), { data: { ok: true } });
  });
});
