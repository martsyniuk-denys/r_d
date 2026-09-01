import 'reflect-metadata';

import type { CanActivate, Component, Interceptor } from './lifecycle';
import {
  CONTROLLER_METADATA,
  GUARDS_METADATA,
  INTERCEPTORS_METADATA,
  PARAMS_METADATA,
  ROUTES_METADATA,
  type Constructor,
  type HttpMethod,
  type ParamMap,
  type RouteMetadata,
} from './metadata';

export interface Route {
  method: HttpMethod;
  path: string;
  segments: string[];
  controller: Constructor;
  handlerName: string;
  params: ParamMap;
  paramTypes: unknown[];
  guards: Component<CanActivate>[];
  interceptors: Component<Interceptor>[];
}

export interface RouteMatch {
  route: Route;
  params: Record<string, string>;
}

export class Router {
  private readonly routes: Route[] = [];

  register(controller: Constructor): this {
    const prefix = Reflect.getMetadata(CONTROLLER_METADATA, controller) as string | undefined;

    if (prefix === undefined) {
      throw new Error(`${controller.name} is not decorated with @Controller()`);
    }

    const prototype = controller.prototype as object;
    const declared =
      (Reflect.getMetadata(ROUTES_METADATA, prototype) as RouteMetadata[] | undefined) ?? [];

    for (const route of declared) {
      this.routes.push({
        method: route.method,
        path: joinPath(prefix, route.path),
        segments: splitPath(joinPath(prefix, route.path)),
        controller,
        handlerName: route.handlerName,
        params:
          (Reflect.getMetadata(PARAMS_METADATA, prototype, route.handlerName) as
            | ParamMap
            | undefined) ?? {},
        paramTypes:
          (Reflect.getMetadata('design:paramtypes', prototype, route.handlerName) as
            | unknown[]
            | undefined) ?? [],
        guards: collect(GUARDS_METADATA, controller, prototype, route.handlerName),
        interceptors: collect(INTERCEPTORS_METADATA, controller, prototype, route.handlerName),
      });
    }

    this.routes.sort((a, b) => countDynamic(a) - countDynamic(b));

    return this;
  }

  list(): readonly Route[] {
    return this.routes;
  }

  match(method: string, pathname: string): RouteMatch | undefined {
    const parts = splitPath(pathname);

    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;

      const params: Record<string, string> = {};
      let matched = true;

      for (let i = 0; i < route.segments.length; i += 1) {
        const segment = route.segments[i] as string;
        const value = parts[i] as string;

        if (segment.startsWith(':')) {
          params[segment.slice(1)] = decodeURIComponent(value);
          continue;
        }

        if (segment !== value) {
          matched = false;
          break;
        }
      }

      if (matched) return { route, params };
    }

    return undefined;
  }
}

export function joinPath(prefix: string, path: string): string {
  const segments = [...splitPath(prefix), ...splitPath(path)];
  return `/${segments.join('/')}`;
}

export function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

function collect<T>(
  key: symbol,
  controller: Constructor,
  prototype: object,
  handlerName: string,
): T[] {
  const onClass = (Reflect.getMetadata(key, controller) as T[] | undefined) ?? [];
  const onMethod = (Reflect.getMetadata(key, prototype, handlerName) as T[] | undefined) ?? [];

  return [...onClass, ...onMethod];
}

function countDynamic(route: Route): number {
  return route.segments.filter((segment) => segment.startsWith(':')).length;
}
