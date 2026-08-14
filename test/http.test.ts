import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Container } from '../src/container';
import { HealthController } from '../src/controllers/health.controller';
import { UsersController } from '../src/controllers/users.controller';
import { Controller } from '../src/decorators/controller';
import { Post } from '../src/decorators/methods';
import { Body } from '../src/decorators/params';
import { Dispatcher } from '../src/dispatcher';
import { CreateUserDto } from '../src/dto/create-user.dto';
import { Router } from '../src/router';
import { UsersService, type User } from '../src/services/users.service';

@Controller('echo')
class EchoController {
  static received: unknown;

  @Post()
  create(@Body() dto: CreateUserDto): unknown {
    EchoController.received = dto;
    return { name: dto.name };
  }
}

const container = new Container();
const router = new Router()
  .register(HealthController)
  .register(UsersController)
  .register(EchoController);
const dispatcher = new Dispatcher(container, router);

let baseUrl = '';

before(async () => {
  baseUrl = await dispatcher.listen(0);
});

after(async () => {
  await dispatcher.close();
});

describe('http dispatcher', () => {
  it('serves GET /users/42 through the controller prefix and @Param', async () => {
    const response = await fetch(`${baseUrl}/users/42`);
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.match(text, /42/);
    assert.equal((JSON.parse(text) as User).name, 'Grace Hopper');
  });

  it('serves a controller registered with an empty prefix', async () => {
    const response = await fetch(`${baseUrl}/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  });

  it('passes @Query values to the handler as a separate argument', async () => {
    const response = await fetch(`${baseUrl}/users?limit=1`);
    const users = (await response.json()) as User[];

    assert.equal(response.status, 200);
    assert.equal(users.length, 1);
  });

  it('converts a @Query value to the declared parameter type', async () => {
    const response = await fetch(`${baseUrl}/users?limit=not-a-number`);
    const body = (await response.json()) as { message: string };

    assert.equal(response.status, 400);
    assert.match(body.message, /must be a number/);
  });

  it('parses the JSON body and answers 201 for a valid POST', async () => {
    const response = await fetch(`${baseUrl}/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Alan Turing', email: 'alan@example.com', age: 41 }),
    });
    const created = (await response.json()) as User;

    assert.equal(response.status, 201);
    assert.equal(created.name, 'Alan Turing');
    assert.equal(typeof created.id, 'number');
  });

  it('hands the handler an instance of the DTO class, not a plain object', async () => {
    EchoController.received = undefined;

    const response = await fetch(`${baseUrl}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada', email: 'ada@example.com' }),
    });

    assert.equal(response.status, 201);
    assert.ok(EchoController.received instanceof CreateUserDto);
    assert.equal((EchoController.received as CreateUserDto).email, 'ada@example.com');
  });

  it('rejects an invalid body with 400 and names every failing field', async () => {
    const response = await fetch(`${baseUrl}/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', email: 'not-an-email' }),
    });
    const text = await response.text();
    const body = JSON.parse(text) as { errors: { field: string; constraints: string[] }[] };

    assert.equal(response.status, 400);
    assert.match(text, /email/);

    const fields = body.errors.map((error) => error.field).sort();

    assert.deepEqual(fields, ['email', 'name']);
    assert.ok(body.errors.every((error) => error.constraints.length > 0));
  });

  it('answers 400 for a malformed JSON body', async () => {
    const response = await fetch(`${baseUrl}/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });
    const body = (await response.json()) as { message: string };

    assert.equal(response.status, 400);
    assert.match(body.message, /Invalid JSON body/);
  });

  it('answers 404 for an unknown route and for a wrong method', async () => {
    const unknown = await fetch(`${baseUrl}/nope`);
    const wrongMethod = await fetch(`${baseUrl}/users/42`, { method: 'POST' });

    assert.equal(unknown.status, 404);
    assert.equal(wrongMethod.status, 404);
    assert.match(((await unknown.json()) as { message: string }).message, /Cannot GET \/nope/);
  });

  it('builds the controller through the container and shares the singleton service', async () => {
    const controller = container.resolve(UsersController);
    const service = container.resolve(UsersService);

    assert.equal(controller.users, service);
    assert.equal(container.resolve(UsersController), controller);

    const created = service.create({ name: 'Katherine Johnson', email: 'kj@example.com' });
    const response = await fetch(`${baseUrl}/users/${created.id}`);

    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as User).name, 'Katherine Johnson');
  });
});
