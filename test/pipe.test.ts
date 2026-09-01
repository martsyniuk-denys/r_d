import 'reflect-metadata';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { z } from 'zod';

import { Controller } from '../src/decorators/controller';
import { Post } from '../src/decorators/methods';
import { Body, Param } from '../src/decorators/params';
import { Get } from '../src/decorators/methods';
import { createUserSchema } from '../src/dto/create-user.dto';
import { ValidationError } from '../src/errors';
import { ZodValidationPipe } from '../src/pipes/zod-validation.pipe';
import type { ArgumentMetadata } from '../src/lifecycle';
import { startApp, type TestApp } from './support/app';

@Controller('accounts')
class AccountsController {
  static received: unknown;

  @Post()
  create(@Body(createUserSchema) dto: unknown): unknown {
    AccountsController.received = dto;
    return dto;
  }

  @Get(':id')
  read(@Param('id') id: number): { id: number; type: string } {
    return { id, type: typeof id };
  }
}

const pipe = new ZodValidationPipe();

function metadata(schema?: unknown): ArgumentMetadata {
  return { index: 0, source: 'body', metatype: Object, schema };
}

let app: TestApp;

before(async () => {
  app = await startApp([AccountsController]);
});

after(async () => {
  await app.close();
});

async function post(body: unknown): Promise<Response> {
  return fetch(`${app.url}/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('ZodValidationPipe', () => {
  it('returns the parsed value for a valid body', async () => {
    const response = await post({ name: 'Alan Turing', email: 'alan@example.com', age: 41 });

    assert.equal(response.status, 201);
    assert.deepEqual(AccountsController.received, {
      name: 'Alan Turing',
      email: 'alan@example.com',
      age: 41,
    });
  });

  it('answers 400 and names every failing field', async () => {
    const response = await post({ name: 'x', email: 'not-an-email' });
    const body = (await response.json()) as {
      statusCode: number;
      errors: { field: string; constraints: string[] }[];
    };

    assert.equal(response.status, 400);
    assert.equal(body.statusCode, 400);
    assert.deepEqual(
      body.errors.map((error) => error.field).sort(),
      ['email', 'name'],
    );
    assert.ok(body.errors.every((error) => error.constraints.length > 0));
  });

  it('reports a missing required field rather than passing undefined on', async () => {
    const response = await post({ name: 'Ada Lovelace' });
    const body = (await response.json()) as { errors: { field: string }[] };

    assert.equal(response.status, 400);
    assert.deepEqual(body.errors.map((error) => error.field), ['email']);
  });

  it('rejects unknown keys, so the handler never sees them', async () => {
    const response = await post({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      isAdmin: true,
    });

    assert.equal(response.status, 400);
    assert.match(await response.text(), /isAdmin/);
  });

  it('passes arguments without a schema straight through', () => {
    assert.equal(pipe.transform('42', metadata()), '42');
    assert.equal(pipe.transform(7, metadata(undefined)), 7);
  });

  it('groups several Zod issues onto one field', () => {
    const schema = z.object({ tag: z.string().min(5, 'too short').regex(/^a/, 'must start with a') });

    try {
      pipe.transform({ tag: 'b' }, metadata(schema));
      assert.fail('expected the pipe to throw');
    } catch (error) {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.errors.length, 1);
      assert.deepEqual(error.errors[0]?.constraints, ['too short', 'must start with a']);
    }
  });

  it('leaves the primitive coercion of @Param in place', async () => {
    const response = await fetch(`${app.url}/accounts/42`);

    assert.deepEqual(await response.json(), { id: 42, type: 'number' });
  });
});
