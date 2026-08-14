import 'reflect-metadata';

import { ROUTES_METADATA, type HttpMethod, type RouteMetadata } from '../metadata';

function createMethodDecorator(method: HttpMethod) {
  return (path = '/'): MethodDecorator => {
    return (target, propertyKey) => {
      const own =
        (Reflect.getOwnMetadata(ROUTES_METADATA, target) as RouteMetadata[] | undefined) ?? [];

      const routes: RouteMetadata[] = [
        ...own,
        { method, path, handlerName: String(propertyKey) },
      ];

      Reflect.defineMetadata(ROUTES_METADATA, routes, target);
    };
  };
}

export const Get = createMethodDecorator('GET');

export const Post = createMethodDecorator('POST');
