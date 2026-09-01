import type http from 'node:http';

import type { Constructor, ParamSource } from './metadata';
import type { Route } from './router';

export interface ExecutionContext {
  readonly req: http.IncomingMessage;
  readonly res: http.ServerResponse;
  readonly method: string;
  readonly path: string;
  readonly url: URL;
  readonly requestId: string;
  route?: Route;
  params: Record<string, string>;
  body?: unknown;
}

export type Component<T> = Constructor<T> | T;

export interface Middleware {
  use(context: ExecutionContext, next: () => Promise<void>): Promise<void> | void;
}

export interface CanActivate {
  canActivate(context: ExecutionContext): boolean | Promise<boolean>;
}

export type CallHandler = () => Promise<unknown>;

export interface Interceptor {
  intercept(context: ExecutionContext, next: CallHandler): Promise<unknown>;
}

export interface ArgumentMetadata {
  index: number;
  source: ParamSource;
  name?: string;
  metatype: unknown;
  schema?: unknown;
}

export interface PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown | Promise<unknown>;
}

export interface ExceptionFilter {
  catch(error: unknown, context: ExecutionContext): void;
}
