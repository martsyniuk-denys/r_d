import 'reflect-metadata';

import { Container } from './container';
import { HealthController } from './controllers/health.controller';
import { UsersController } from './controllers/users.controller';
import { Dispatcher } from './dispatcher';
import { Router } from './router';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

async function bootstrap(): Promise<void> {
  const container = new Container();
  const router = new Router().register(HealthController).register(UsersController);
  const dispatcher = new Dispatcher(container, router);

  const url = await dispatcher.listen(PORT, HOST);

  console.log(`mini-nest listening on ${url}`);
  for (const route of router.list()) {
    console.log(`  ${route.method.padEnd(4)} ${route.path} -> ${route.controller.name}.${route.handlerName}()`);
  }
}

void bootstrap();
