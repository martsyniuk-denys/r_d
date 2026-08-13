export const INJECTABLE_METADATA = Symbol('ioc:injectable');

export const SCOPE_METADATA = Symbol('ioc:scope');

export const INJECT_METADATA = Symbol('ioc:inject');

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

export function isConstructor(token: unknown): token is Constructor {
  return typeof token === 'function' && token.prototype !== undefined;
}

export function describeToken(token: Token): string {
  if (typeof token === 'string') return token;
  if (typeof token === 'symbol') return token.description ?? token.toString();
  return token.name || '<anonymous class>';
}
