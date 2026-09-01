import 'reflect-metadata';

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { Container } from './container';
import { resolveRequestId } from './context/request-context';
import { ForbiddenError, HttpError, NotFoundError } from './errors';
import { HttpExceptionFilter } from './filters/exception.filter';
import type {
  ArgumentMetadata,
  CallHandler,
  CanActivate,
  Component,
  ExceptionFilter,
  ExecutionContext,
  Interceptor,
  Middleware,
  PipeTransform,
} from './lifecycle';
import { isConstructor, type ParamDefinition } from './metadata';
import { send } from './response';
import { Router, type Route } from './router';
import { ZodValidationPipe } from './pipes/zod-validation.pipe';

const MAX_BODY_BYTES = 1_000_000;
const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH']);

type Handler = (...args: unknown[]) => unknown;

export interface DispatcherOptions {
  middleware?: Component<Middleware>[];
  guards?: Component<CanActivate>[];
  interceptors?: Component<Interceptor>[];
  pipes?: Component<PipeTransform>[];
  filter?: ExceptionFilter;
}

export class Dispatcher {
  private readonly container: Container;
  private readonly router: Router;
  private readonly middleware: Middleware[];
  private readonly guards: Component<CanActivate>[];
  private readonly interceptors: Component<Interceptor>[];
  private readonly pipes: PipeTransform[];
  private readonly filter: ExceptionFilter;
  private server?: http.Server;

  constructor(container: Container, router: Router, options: DispatcherOptions = {}) {
    this.container = container;
    this.router = router;
    this.middleware = (options.middleware ?? []).map((item) => this.instantiate(item));
    this.guards = options.guards ?? [];
    this.interceptors = options.interceptors ?? [];
    this.pipes = (options.pipes ?? [new ZodValidationPipe()]).map((item) => this.instantiate(item));
    this.filter = options.filter ?? new HttpExceptionFilter();
  }

  createServer(): http.Server {
    return http.createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  async listen(port = 0, host = '127.0.0.1'): Promise<string> {
    const server = this.createServer();
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });

    const { port: bound } = server.address() as AddressInfo;

    return `http://${host}:${bound}`;
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;

    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const context = createExecutionContext(req, res);

    try {
      await this.runMiddleware(context, 0);
    } catch (error) {
      this.filter.catch(error, context);
    }
  }

  private async runMiddleware(context: ExecutionContext, index: number): Promise<void> {
    const middleware = this.middleware[index];

    if (!middleware) {
      await this.dispatch(context);
      return;
    }

    await middleware.use(context, () => this.runMiddleware(context, index + 1));
  }

  private async dispatch(context: ExecutionContext): Promise<void> {
    const matched = this.router.match(context.method, context.path);

    if (!matched) {
      throw new NotFoundError(`Cannot ${context.method} ${context.path}`);
    }

    context.route = matched.route;
    context.params = matched.params;

    const { route } = matched;
    const controller = this.container.resolve(route.controller) as Record<string, Handler>;
    const handler = controller[route.handlerName];

    if (typeof handler !== 'function') {
      throw new HttpError(500, `${route.controller.name} has no ${route.handlerName}()`);
    }

    await this.runGuards(context, route);

    const result = await this.runInterceptors(context, this.interceptorsFor(route), 0, async () => {
      context.body = METHODS_WITH_BODY.has(context.method)
        ? await readJsonBody(context.req)
        : undefined;

      const args = await this.buildArguments(context, route);

      return handler.apply(controller, args);
    });

    send(context.res, defaultStatus(context.method), result);
  }

  private async runGuards(context: ExecutionContext, route: Route): Promise<void> {
    for (const component of this.guardsFor(route)) {
      const guard = this.instantiate(component);

      if (!(await guard.canActivate(context))) {
        throw new ForbiddenError();
      }
    }
  }

  private async runInterceptors(
    context: ExecutionContext,
    components: Component<Interceptor>[],
    index: number,
    call: CallHandler,
  ): Promise<unknown> {
    const component = components[index];

    if (!component) return call();

    const interceptor = this.instantiate(component);

    return interceptor.intercept(context, () =>
      this.runInterceptors(context, components, index + 1, call),
    );
  }

  private guardsFor(route: Route): Component<CanActivate>[] {
    return [...this.guards, ...route.guards];
  }

  private interceptorsFor(route: Route): Component<Interceptor>[] {
    return [...this.interceptors, ...route.interceptors];
  }

  private instantiate<T>(component: Component<T>): T {
    return isConstructor(component) ? (this.container.resolve(component) as T) : (component as T);
  }

  private async buildArguments(context: ExecutionContext, route: Route): Promise<unknown[]> {
    const indexes = Object.keys(route.params).map((key) => Number(key) + 1);
    const length = Math.max(route.paramTypes.length, ...indexes, 0);
    const args: unknown[] = new Array(length).fill(undefined);

    for (let index = 0; index < length; index += 1) {
      const definition = route.params[index];
      if (!definition) continue;

      const metatype = route.paramTypes[index];
      const raw =
        definition.source === 'body'
          ? context.body
          : coerce(read(definition, context), metatype, describe(definition));

      args[index] = await this.runPipes(raw, {
        index,
        source: definition.source,
        name: definition.name,
        metatype,
        schema: definition.schema,
      });
    }

    return args;
  }

  private async runPipes(value: unknown, metadata: ArgumentMetadata): Promise<unknown> {
    let current = value;

    for (const pipe of this.pipes) {
      current = await pipe.transform(current, metadata);
    }

    return current;
  }
}

function createExecutionContext(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): ExecutionContext {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  return {
    req,
    res,
    method,
    url,
    path: url.pathname,
    requestId: resolveRequestId(req.headers['x-request-id']),
    params: {},
  };
}

function read(
  definition: ParamDefinition,
  context: ExecutionContext,
): string | Record<string, string> | undefined {
  if (definition.source === 'param') {
    return definition.name === undefined ? context.params : context.params[definition.name];
  }

  const query = context.url.searchParams;

  return definition.name === undefined
    ? Object.fromEntries(query)
    : (query.get(definition.name) ?? undefined);
}

function coerce(
  value: string | Record<string, string> | undefined,
  type: unknown,
  where: string,
): unknown {
  if (typeof value !== 'string') return value;

  if (type === Number) {
    const parsed = Number(value);
    if (Number.isNaN(parsed)) {
      throw new HttpError(400, `${where} must be a number, got "${value}"`);
    }
    return parsed;
  }

  if (type === Boolean) {
    return value === 'true' || value === '1';
  }

  return value;
}

function describe(definition: ParamDefinition): string {
  return `${definition.source} "${definition.name ?? ''}"`;
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;

    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'Request body is too large');
    }

    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw.length === 0) return undefined;

  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

function defaultStatus(method: string): number {
  return method === 'POST' ? 201 : 200;
}
