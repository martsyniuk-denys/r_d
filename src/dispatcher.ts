import 'reflect-metadata';

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { Container } from './container';
import { HttpError, ValidationFailedError } from './errors';
import { ValidationPipe } from './pipes/validation.pipe';
import { Router, type RouteMatch } from './router';
import type { ParamDefinition } from './metadata';

const MAX_BODY_BYTES = 1_000_000;
const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH']);

type Handler = (...args: unknown[]) => unknown;

export class Dispatcher {
  private readonly container: Container;
  private readonly router: Router;
  private readonly validation: ValidationPipe;
  private server?: http.Server;

  constructor(container: Container, router: Router, validation = new ValidationPipe()) {
    this.container = container;
    this.router = router;
    this.validation = validation;
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
    try {
      const method = req.method ?? 'GET';
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const matched = this.router.match(method, url.pathname);

      if (!matched) {
        throw new HttpError(404, `Cannot ${method} ${url.pathname}`);
      }

      const body = METHODS_WITH_BODY.has(method) ? await readJsonBody(req) : undefined;
      const args = await this.buildArguments(matched, body, url.searchParams);

      const controller = this.container.resolve(matched.route.controller) as Record<string, Handler>;
      const handler = controller[matched.route.handlerName];

      if (typeof handler !== 'function') {
        throw new HttpError(500, `${matched.route.controller.name} has no ${matched.route.handlerName}()`);
      }

      send(res, defaultStatus(method), await handler.apply(controller, args));
    } catch (error) {
      sendError(res, error);
    }
  }

  private async buildArguments(
    matched: RouteMatch,
    body: unknown,
    query: URLSearchParams,
  ): Promise<unknown[]> {
    const { route } = matched;
    const indexes = Object.keys(route.params).map((key) => Number(key) + 1);
    const length = Math.max(route.paramTypes.length, ...indexes, 0);
    const args: unknown[] = new Array(length).fill(undefined);

    for (let index = 0; index < length; index += 1) {
      const definition = route.params[index];
      if (!definition) continue;

      const type = route.paramTypes[index];

      if (definition.source === 'body') {
        args[index] = await this.validation.transform(body, type);
        continue;
      }

      args[index] = coerce(read(definition, matched.params, query), type, describe(definition));
    }

    return args;
  }
}

function read(
  definition: ParamDefinition,
  params: Record<string, string>,
  query: URLSearchParams,
): string | Record<string, string> | undefined {
  if (definition.source === 'param') {
    return definition.name === undefined ? params : params[definition.name];
  }

  return definition.name === undefined ? Object.fromEntries(query) : (query.get(definition.name) ?? undefined);
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

function send(res: http.ServerResponse, status: number, payload: unknown): void {
  if (payload === undefined) {
    res.writeHead(204).end();
    return;
  }

  const json = JSON.stringify(payload);

  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
  });
  res.end(json);
}

function sendError(res: http.ServerResponse, error: unknown): void {
  if (error instanceof ValidationFailedError) {
    send(res, error.status, {
      statusCode: error.status,
      message: error.message,
      errors: error.errors,
    });
    return;
  }

  if (error instanceof HttpError) {
    send(res, error.status, { statusCode: error.status, message: error.message });
    return;
  }

  console.error(error);
  send(res, 500, { statusCode: 500, message: 'Internal server error' });
}
