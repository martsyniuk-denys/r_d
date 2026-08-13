import 'reflect-metadata';

import { INJECT_METADATA, type InjectMap, type Token } from '../metadata';

export function Inject(token: Token): ParameterDecorator {
  return (target, _propertyKey, parameterIndex) => {
    const own = (Reflect.getOwnMetadata(INJECT_METADATA, target) as InjectMap | undefined) ?? {};
    const map: InjectMap = { ...own, [parameterIndex]: token };

    Reflect.defineMetadata(INJECT_METADATA, map, target);
  };
}
