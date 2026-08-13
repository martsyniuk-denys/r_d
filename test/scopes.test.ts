import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Container } from '../src/container';
import { Injectable } from '../src/decorators/injectable';

@Injectable()
class SharedCache {
  readonly id = Symbol('cache');
}

@Injectable()
class UsersRepo {
  constructor(readonly cache: SharedCache) {}
}

@Injectable()
class OrdersRepo {
  constructor(readonly cache: SharedCache) {}
}

@Injectable({ scope: 'transient' })
class RequestContext {
  readonly id = Math.random();
}

@Injectable()
class RequestLogger {
  constructor(readonly context: RequestContext) {}
}

describe('scopes', () => {
  it('singleton (the default) returns the very same instance', () => {
    const container = new Container();

    assert.equal(container.resolve(UsersRepo), container.resolve(UsersRepo));
  });

  it('shares one singleton dependency between different consumers', () => {
    const container = new Container();

    const users = container.resolve(UsersRepo);
    const orders = container.resolve(OrdersRepo);

    assert.notEqual(users, orders);
    assert.equal(users.cache, orders.cache, 'both repos must get the same SharedCache');
  });

  it('transient returns a new instance on every resolve', () => {
    const container = new Container();

    assert.notEqual(container.resolve(RequestContext), container.resolve(RequestContext));
  });

  it('injects a fresh transient into each newly built consumer', () => {
    const container = new Container();

    const logger = container.resolve(RequestLogger);
    const standalone = container.resolve(RequestContext);

    assert.ok(logger.context instanceof RequestContext);
    assert.notEqual(logger.context, standalone);
    assert.equal(container.resolve(RequestLogger).context, logger.context);
  });

  it('keeps caches separate per container', () => {
    const first = new Container();
    const second = new Container();

    assert.notEqual(first.resolve(UsersRepo), second.resolve(UsersRepo));
  });

  it('lets a provider override the scope declared on the class', () => {
    const container = new Container();
    container.register(UsersRepo, { useClass: UsersRepo, scope: 'transient' });

    assert.notEqual(container.resolve(UsersRepo), container.resolve(UsersRepo));
  });
});
