import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Controller } from '../src/decorators/controller';
import { Get, Post } from '../src/decorators/methods';
import { Body, Param, Query } from '../src/decorators/params';
import { CreateUserDto } from '../src/dto/create-user.dto';
import { PARAMS_METADATA, ROUTES_METADATA } from '../src/metadata';
import { Router, joinPath } from '../src/router';

@Controller('users')
class UsersRoutes {
  @Get()
  findAll(@Query('limit') limit?: number): unknown {
    return limit;
  }

  @Get(':id')
  findOne(@Param('id') id: number): unknown {
    return id;
  }

  @Post()
  create(@Body() dto: CreateUserDto): unknown {
    return dto;
  }
}

@Controller()
class RootRoutes {
  @Get('health')
  health(): unknown {
    return { status: 'ok' };
  }
}

class Undecorated {}

describe('router', () => {
  it('collects routes from decorator metadata, not from a hardcoded list', () => {
    const declared = Reflect.getMetadata(ROUTES_METADATA, UsersRoutes.prototype);

    assert.deepEqual(declared, [
      { method: 'GET', path: '/', handlerName: 'findAll' },
      { method: 'GET', path: ':id', handlerName: 'findOne' },
      { method: 'POST', path: '/', handlerName: 'create' },
    ]);
  });

  it('joins the controller prefix with the method path', () => {
    const paths = new Router()
      .register(UsersRoutes)
      .list()
      .map((route) => `${route.method} ${route.path}`);

    assert.deepEqual(paths.sort(), ['GET /users', 'GET /users/:id', 'POST /users'].sort());
    assert.equal(joinPath('users', ':id'), '/users/:id');
    assert.equal(joinPath('/users/', '/:id/'), '/users/:id');
  });

  it('matches a dynamic segment and extracts the value', () => {
    const matched = new Router().register(UsersRoutes).match('GET', '/users/42');

    assert.ok(matched);
    assert.equal(matched.route.handlerName, 'findOne');
    assert.deepEqual(matched.params, { id: '42' });
  });

  it('prefers a static segment over a dynamic one', () => {
    @Controller('users')
    class Ambiguous {
      @Get(':id')
      dynamic(): unknown {
        return null;
      }

      @Get('me')
      static_(): unknown {
        return null;
      }
    }

    const router = new Router().register(Ambiguous);

    assert.equal(router.match('GET', '/users/me')?.route.handlerName, 'static_');
    assert.equal(router.match('GET', '/users/7')?.route.handlerName, 'dynamic');
  });

  it('handles an empty prefix and ignores trailing slashes', () => {
    const router = new Router().register(RootRoutes);

    assert.equal(router.match('GET', '/health')?.route.handlerName, 'health');
    assert.equal(router.match('GET', '/health/')?.route.handlerName, 'health');
  });

  it('returns undefined for an unknown path or a wrong method', () => {
    const router = new Router().register(UsersRoutes);

    assert.equal(router.match('GET', '/nope'), undefined);
    assert.equal(router.match('POST', '/users/42'), undefined);
  });

  it('records where every handler argument comes from', () => {
    const params = Reflect.getMetadata(PARAMS_METADATA, UsersRoutes.prototype, 'findOne');

    assert.deepEqual(params, { 0: { source: 'param', name: 'id' } });

    const route = new Router()
      .register(UsersRoutes)
      .list()
      .find((candidate) => candidate.handlerName === 'create');

    assert.deepEqual(route?.params, { 0: { source: 'body', name: undefined } });
    assert.deepEqual(route?.paramTypes, [CreateUserDto]);
  });

  it('runs parameter decorators first, then the method decorator, then the class one', () => {
    const order: string[] = [];

    function TraceClass(): ClassDecorator {
      return () => {
        order.push('class');
      };
    }

    function TraceMethod(): MethodDecorator {
      return () => {
        order.push('method');
      };
    }

    function TraceParam(): ParameterDecorator {
      return () => {
        order.push('param');
      };
    }

    @TraceClass()
    class Probe {
      @TraceMethod()
      handle(@TraceParam() value: string): string {
        return value;
      }
    }

    assert.equal(new Probe().handle('ok'), 'ok');
    assert.deepEqual(order, ['param', 'method', 'class']);
  });

  it('refuses a class without @Controller()', () => {
    assert.throws(
      () => new Router().register(Undecorated),
      /Undecorated is not decorated with @Controller\(\)/,
    );
  });
});
