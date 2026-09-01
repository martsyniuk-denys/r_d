import 'reflect-metadata';

import type { CanActivate, Component, Interceptor } from '../lifecycle';
import { GUARDS_METADATA, INTERCEPTORS_METADATA } from '../metadata';

type ClassOrMethodDecorator = ClassDecorator & MethodDecorator;

function attach(key: symbol, components: unknown[]): ClassOrMethodDecorator {
  return ((target: object, propertyKey?: string | symbol) => {
    if (propertyKey === undefined) {
      Reflect.defineMetadata(key, components, target);
      return;
    }

    Reflect.defineMetadata(key, components, target, propertyKey);
  }) as ClassOrMethodDecorator;
}

export function UseGuards(...guards: Component<CanActivate>[]): ClassOrMethodDecorator {
  return attach(GUARDS_METADATA, guards);
}

export function UseInterceptors(
  ...interceptors: Component<Interceptor>[]
): ClassOrMethodDecorator {
  return attach(INTERCEPTORS_METADATA, interceptors);
}
