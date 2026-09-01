import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { HealthController } from '../src/controllers/health.controller';
import { UsersController } from '../src/controllers/users.controller';
import { Controller } from '../src/decorators/controller';
import { Post } from '../src/decorators/methods';
import { Body } from '../src/decorators/params';
import { createUserSchema, type CreateUserDto } from '../src/dto/create-user.dto';
import { UsersService, type User } from '../src/services/users.service';
import { AUTH, startApp, type TestApp } from './support/app';

@Controller('echo')
class EchoController {
  static received: unknown;

  @Post()
  create(@Body(createUserSchema) dto: CreateUserDto): unknown {
    EchoController.received = dto;
    return { name: dto.name };
  }
}

let app: TestApp;
let baseUrl = '';
let container: TestApp['container'];

before(async () => {
  app = await startApp([HealthController, UsersController, EchoController]);
  baseUrl = app.url;
  container = app.container;
});

after(async () => {
  await app.close();
});

describe('http dispatcher', () => {
  it('serves GET /users/42 through the controller prefix and @Param', async () => {
    const response = await fetch(`${baseUrl}/users/42`, { headers: AUTH });
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
    const response = await fetch(`${baseUrl}/users?limit=1`, { headers: AUTH });
    const users = (await response.json()) as User[];

    assert.equal(response.status, 200);
    assert.equal(users.length, 1);
  });

  it('converts a @Query value to the declared parameter type', async () => {
    const response = await fetch(`${baseUrl}/users?limit=not-a-number`, { headers: AUTH });
    const body = (await response.json()) as { message: string };

    assert.equal(response.status, 400);
    assert.match(body.message, /must be a number/);
  });

  it('parses the JSON body and answers 201 for a valid POST', async () => {
    const response = await fetch(`${baseUrl}/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH },
      body: JSON.stringify({ name: 'Alan Turing', email: 'alan@example.com', age: 41 }),
    });
    const created = (await response.json()) as User;

    assert.equal(response.status, 201);
    assert.equal(created.name, 'Alan Turing');
    assert.equal(typeof created.id, 'number');
  });

  it('hands the handler the value the schema parsed, not the raw body', async () => {
    EchoController.received = undefined;

    const response = await fetch(`${baseUrl}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH },
      body: JSON.stringify({ name: 'Ada', email: 'ada@example.com' }),
    });

    assert.equal(response.status, 201);
    assert.deepEqual(EchoController.received, { name: 'Ada', email: 'ada@example.com' });
  });

  it('rejects an invalid body with 400 and names every failing field', async () => {
    const response = await fetch(`${baseUrl}/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...AUTH },
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
      headers: { 'content-type': 'application/json', ...AUTH },
      body: '{ not json',
    });
    const body = (await response.json()) as { message: string };

    assert.equal(response.status, 400);
    assert.match(body.message, /Invalid JSON body/);
  });

  it('answers 404 for an unknown route and for a wrong method', async () => {
    const unknown = await fetch(`${baseUrl}/nope`);
    const wrongMethod = await fetch(`${baseUrl}/users/42`, { method: 'POST', headers: AUTH });

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
    const response = await fetch(`${baseUrl}/users/${created.id}`, { headers: AUTH });

    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as User).name, 'Katherine Johnson');
  });
});
