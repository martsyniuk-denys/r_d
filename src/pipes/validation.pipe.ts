import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';

import { ValidationFailedError, type FieldError } from '../errors';
import { isConstructor, type Constructor } from '../metadata';

const NATIVE_TYPES: readonly unknown[] = [Object, String, Number, Boolean, Array];

export class ValidationPipe {
  async transform(value: unknown, metatype: unknown): Promise<unknown> {
    if (!isConstructor(metatype) || NATIVE_TYPES.includes(metatype)) {
      return value;
    }

    const instance = plainToInstance(metatype as Constructor<object>, value ?? {});
    const errors = await validate(instance as object, {
      whitelist: true,
      validationError: { target: false, value: false },
    });

    if (errors.length > 0) {
      throw new ValidationFailedError(errors.flatMap((error) => flatten(error)));
    }

    return instance;
  }
}

function flatten(error: ValidationError, parent = ''): FieldError[] {
  const field = parent ? `${parent}.${error.property}` : error.property;
  const own: FieldError[] = error.constraints
    ? [{ field, constraints: Object.values(error.constraints) }]
    : [];

  const nested = (error.children ?? []).flatMap((child) => flatten(child, field));

  return [...own, ...nested];
}
