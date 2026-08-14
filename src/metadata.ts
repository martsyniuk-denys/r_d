export const INJECTABLE_METADATA = Symbol('ioc:injectable');

export const SCOPE_METADATA = Symbol('ioc:scope');

export const INJECT_METADATA = Symbol('ioc:inject');

export const CONTROLLER_METADATA = Symbol('http:controller');

export const ROUTES_METADATA = Symbol('http:routes');

export const PARAMS_METADATA = Symbol('http:params');

export type Constructor<T = unknown> = new (...args: any[]) => T;

export type Token<T = unknown> = string | symbol | Constructor<T>;

export type Scope = 'singleton' | 'transient';

export interface InjectableOptions {
  scope?: Scope;
}

export type InjectMap = Record<number, Token>;

export type Provider<T = unknown> =
  | { useClass: Constructor<T>; scope?: Scope }
  | { useValue: T };

export type HttpMethod = 'GET' | 'POST';

export type ParamSource = 'body' | 'param' | 'query';

export interface ParamDefinition {
  source: ParamSource;
  name?: string;
}

export type ParamMap = Record<number, ParamDefinition>;

export interface RouteMetadata {
  method: HttpMethod;
  path: string;
  handlerName: string;
}

export function isConstructor(token: unknown): token is Constructor {
  return typeof token === 'function' && token.prototype !== undefined;
}

export function describeToken(token: Token): string {
  if (typeof token === 'string') return token;
  if (typeof token === 'symbol') return token.description ?? token.toString();
  return token.name || '<anonymous class>';
}
