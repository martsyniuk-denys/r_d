import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Controller } from '../src/decorators/controller';
import { Get, Post } from '../src/decorators/methods';
import { Body } from '../src/decorators/params';
import { UseGuards } from '../src/decorators/use';
import { Injectable } from '../src/decorators/injectable';
import { AuthGuard } from '../src/guards/auth.guard';
import type { CanActivate } from '../src/lifecycle';
import { z } from 'zod';
import { AUTH, startApp, type TestApp } from './support/app';

let handlerCalls = 0;

@Injectable()
class DenyAll implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

@Controller('secret')
@UseGuards(AuthGuard)
class SecretController {
  @Get()
  read(): { ok: boolean } {
    handlerCalls += 1;
    return { ok: true };
  }

  @Get('double')
  @UseGuards(DenyAll)
  never(): { ok: boolean } {
    handlerCalls += 1;
    return { ok: true };
  }

  @Post()
  create(@Body(z.object({ title: z.string() })) body: { title: string }): unknown {
    handlerCalls += 1;
    return body;
  }
}

@Controller('open')
class OpenController {
  @Get()
  read(): { ok: boolean } {
    handlerCalls += 1;
    return { ok: true };
  }
}

let app: TestApp;

before(async () => {
  app = await startApp([SecretController, OpenController]);
});

after(async () => {
  await app.close();
});

beforeEach(() => {
  handlerCalls = 0;
});

describe('AuthGuard', () => {
  it('answers 403 without an Authorization header and never calls the handler', async () => {
    const response = await fetch(`${app.url}/secret`);
    const body = (await response.json()) as { statusCode: number; message: string };

    assert.equal(response.status, 403);
    assert.equal(body.statusCode, 403);
    assert.equal(handlerCalls, 0);
  });

  it('answers 403 for a malformed Authorization header', async () => {
    const response = await fetch(`${app.url}/secret`, {
      headers: { authorization: 'Bearer' },
    });

    assert.equal(response.status, 403);
    assert.equal(handlerCalls, 0);
  });

  it('lets a valid Bearer token through', async () => {
    const response = await fetch(`${app.url}/secret`, { headers: AUTH });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(handlerCalls, 1);
  });

  it('leaves a route without @UseGuards open', async () => {
    const response = await fetch(`${app.url}/open`);

    assert.equal(response.status, 200);
    assert.equal(handlerCalls, 1);
  });

  it('runs the class guard and the method guard, and one "no" is enough', async () => {
    const response = await fetch(`${app.url}/secret/double`, { headers: AUTH });

    assert.equal(response.status, 403);
    assert.equal(handlerCalls, 0);
  });

  it('runs before the pipe: an invalid body behind a closed guard is still 403', async () => {
    const response = await fetch(`${app.url}/secret`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json at all',
    });

    assert.equal(response.status, 403);
    assert.equal(handlerCalls, 0);
  });
});
