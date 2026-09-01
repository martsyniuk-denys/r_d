import 'reflect-metadata';

import { Container } from '../../src/container';
import { Dispatcher, type DispatcherOptions } from '../../src/dispatcher';
import { HttpExceptionFilter } from '../../src/filters/exception.filter';
import { RequestIdMiddleware } from '../../src/middleware/request-id.middleware';
import { Router } from '../../src/router';
import type { Constructor } from '../../src/metadata';

export const AUTH = { authorization: 'Bearer test-token' };

export interface TestApp {
  url: string;
  container: Container;
  close(): Promise<void>;
}

export async function startApp(
  controllers: Constructor[],
  options: DispatcherOptions = {},
): Promise<TestApp> {
  const container = new Container();
  const router = new Router();

  for (const controller of controllers) router.register(controller);

  const dispatcher = new Dispatcher(container, router, {
    middleware: [new RequestIdMiddleware()],
    filter: new HttpExceptionFilter(() => {}),
    ...options,
  });

  const url = await dispatcher.listen(0);

  return { url, container, close: () => dispatcher.close() };
}
