import 'reflect-metadata';

import { CONTROLLER_METADATA, INJECTABLE_METADATA, SCOPE_METADATA } from '../metadata';

export function Controller(prefix = ''): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(CONTROLLER_METADATA, prefix, target);
    Reflect.defineMetadata(INJECTABLE_METADATA, true, target);

    if (!Reflect.hasOwnMetadata(SCOPE_METADATA, target)) {
      Reflect.defineMetadata(SCOPE_METADATA, 'singleton', target);
    }
  };
}
