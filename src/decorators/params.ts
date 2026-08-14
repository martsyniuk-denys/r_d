import 'reflect-metadata';

import { PARAMS_METADATA, type ParamMap, type ParamSource } from '../metadata';

function createParamDecorator(source: ParamSource) {
  return (name?: string): ParameterDecorator => {
    return (target, propertyKey, parameterIndex) => {
      if (propertyKey === undefined) {
        throw new Error(`@${source} can only be used on a controller method parameter`);
      }

      const own =
        (Reflect.getOwnMetadata(PARAMS_METADATA, target, propertyKey) as ParamMap | undefined) ?? {};

      const params: ParamMap = { ...own, [parameterIndex]: { source, name } };

      Reflect.defineMetadata(PARAMS_METADATA, params, target, propertyKey);
    };
  };
}

export const Body = createParamDecorator('body');

export const Param = createParamDecorator('param');

export const Query = createParamDecorator('query');
