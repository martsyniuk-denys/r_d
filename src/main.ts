import 'reflect-metadata';

import { Container } from './container';
import { ContextController } from './controllers/context.controller';
import { HealthController } from './controllers/health.controller';
import { UsersController } from './controllers/users.controller';
import { Dispatcher } from './dispatcher';
import { HttpExceptionFilter } from './filters/exception.filter';
import { LoggingInterceptor } from './interceptors/logging.interceptor';
import { RequestIdMiddleware } from './middleware/request-id.middleware';
import { ZodValidationPipe } from './pipes/zod-validation.pipe';
import { Router } from './router';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

async function bootstrap(): Promise<void> {
  const container = new Container();
  const router = new Router()
    .register(HealthController)
    .register(UsersController)
    .register(ContextController);

  const dispatcher = new Dispatcher(container, router, {
    middleware: [new RequestIdMiddleware()],
    interceptors: [new LoggingInterceptor()],
    pipes: [new ZodValidationPipe()],
    filter: new HttpExceptionFilter(),
  });

  const url = await dispatcher.listen(PORT, HOST);

  console.log(`mini-nest listening on ${url}`);
  for (const route of router.list()) {
    console.log(
      `  ${route.method.padEnd(4)} ${route.path} -> ${route.controller.name}.${route.handlerName}()` +
        (route.guards.length > 0 ? '  [guarded]' : ''),
    );
  }
}

void bootstrap();
