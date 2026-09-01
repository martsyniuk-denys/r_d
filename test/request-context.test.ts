import 'reflect-metadata';

import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';

import { RequestContext, createRequestStore, getRequestId, resolveRequestId } from '../src/context/request-context';
import { ContextController } from '../src/controllers/context.controller';
import { AuditService } from '../src/services/audit.service';
import { UsersService } from '../src/services/users.service';
import { startApp, type TestApp } from './support/app';

interface ContextBody {
  requestId: string;
  seenBy: string;
  users: number;
}

let app: TestApp;

before(async () => {
  app = await startApp([ContextController]);
});

after(async () => {
  await app.close();
});

describe('AsyncLocalStorage request context', () => {
  it('returns undefined outside of any request', () => {
    assert.equal(getRequestId(), undefined);
    assert.equal(RequestContext.get(), undefined);
  });

  it('survives an await inside the run() callback', async () => {
    const seen = await RequestContext.run(createRequestStore('abc'), async () => {
      await delay(5);
      return getRequestId();
    });

    assert.equal(seen, 'abc');
  });

  it('keeps two interleaved run() scopes apart', async () => {
    const first = RequestContext.run(createRequestStore('one'), async () => {
      await delay(10);
      return getRequestId();
    });
    const second = RequestContext.run(createRequestStore('two'), async () => {
      await delay(1);
      return getRequestId();
    });

    assert.deepEqual(await Promise.all([first, second]), ['one', 'two']);
  });

  it('reuses a client-sent id and mints one otherwise', () => {
    assert.equal(resolveRequestId('client-123'), 'client-123');
    assert.equal(resolveRequestId(['first', 'second']), 'first');
    assert.match(resolveRequestId(undefined), /^[0-9a-f-]{36}$/);
    assert.match(resolveRequestId('bad\nvalue'), /^[0-9a-f-]{36}$/);
  });

  it('answers with an X-Request-Id header it generated itself', async () => {
    const response = await fetch(`${app.url}/context`);
    const body = (await response.json()) as ContextBody;

    assert.match(response.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
    assert.equal(body.requestId, response.headers.get('x-request-id'));
  });

  it('echoes the id the client sent', async () => {
    const response = await fetch(`${app.url}/context`, {
      headers: { 'x-request-id': 'client-supplied-id' },
    });

    assert.equal(response.headers.get('x-request-id'), 'client-supplied-id');
    assert.equal(((await response.json()) as ContextBody).requestId, 'client-supplied-id');
  });

  it('reaches a service two levels below the handler with no id in its signature', async () => {
    const response = await fetch(`${app.url}/context`, {
      headers: { 'x-request-id': 'deep-read' },
    });
    const body = (await response.json()) as ContextBody;

    assert.equal(body.seenBy, 'AuditService');
    assert.equal(body.requestId, 'deep-read');

    const audit = app.container.resolve(AuditService);
    const recorded = audit.entries().filter((entry) => entry.requestId === 'deep-read');

    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]?.action, 'users.describeRequest');
    assert.equal(audit, app.container.resolve(UsersService)['audit' as keyof UsersService]);
  });

  it('never mixes contexts across 10 concurrent requests', async () => {
    const ids = Array.from({ length: 10 }, (_, index) => `parallel-${index}`);

    const results = await Promise.all(
      ids.map(async (id) => {
        const response = await fetch(`${app.url}/context`, { headers: { 'x-request-id': id } });
        const body = (await response.json()) as ContextBody;

        return { sent: id, header: response.headers.get('x-request-id'), body: body.requestId };
      }),
    );

    for (const result of results) {
      assert.equal(result.header, result.sent, `header of ${result.sent} leaked`);
      assert.equal(result.body, result.sent, `deep read of ${result.sent} leaked`);
    }

    const seen = app.container
      .resolve(AuditService)
      .entries()
      .map((entry) => entry.requestId)
      .filter((id) => id.startsWith('parallel-'));

    assert.deepEqual([...new Set(seen)].sort(), [...ids].sort());
  });
});
