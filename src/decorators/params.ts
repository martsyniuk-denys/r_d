import 'reflect-metadata';

import type { ZodType } from 'zod';

import { PARAMS_METADATA, type ParamMap, type ParamSource } from '../metadata';

function define(
  source: ParamSource,
  target: object,
  propertyKey: string | symbol | undefined,
  parameterIndex: number,
  extra: { name?: string; schema?: ZodType },
): void {
  if (propertyKey === undefined) {
    throw new Error(`@${source} can only be used on a controller method parameter`);
  }

  const own =
    (Reflect.getOwnMetadata(PARAMS_METADATA, target, propertyKey) as ParamMap | undefined) ?? {};

  const params: ParamMap = { ...own, [parameterIndex]: { source, ...extra } };

  Reflect.defineMetadata(PARAMS_METADATA, params, target, propertyKey);
}

export function Body(schema?: ZodType): ParameterDecorator {
  return (target, propertyKey, parameterIndex) => {
    define('body', target, propertyKey, parameterIndex, { schema });
  };
}

export function Param(name?: string): ParameterDecorator {
  return (target, propertyKey, parameterIndex) => {
    define('param', target, propertyKey, parameterIndex, { name });
  };
}

export function Query(name?: string): ParameterDecorator {
  return (target, propertyKey, parameterIndex) => {
    define('query', target, propertyKey, parameterIndex, { name });
  };
}
