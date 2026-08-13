import 'reflect-metadata';

import { Container } from './container';
import { Inject } from './decorators/inject';
import { Injectable } from './decorators/injectable';
import { CONFIG_TOKEN, LOGGER_TOKEN, type AppConfig, type Logger } from './tokens';

@Injectable()
class Database {
  private readonly rows = new Map<number, string>([[1, 'Ada Lovelace']]);

  findUser(id: number): string | undefined {
    return this.rows.get(id);
  }
}

@Injectable()
class UserService {
  constructor(
    private readonly db: Database,
    @Inject(LOGGER_TOKEN) private readonly logger: Logger,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  greet(id: number): string {
    const user = this.db.findUser(id) ?? 'stranger';
    this.logger.log(`[${this.config.appName}] greeting ${user}`);
    return `Hello, ${user}!`;
  }
}

@Injectable({ scope: 'transient' })
class RequestId {
  readonly value = Math.random().toString(16).slice(2, 8);
}

const container = new Container();

container.register(LOGGER_TOKEN, { useValue: { log: (m: string) => console.log('  ' + m) } });
container.register(CONFIG_TOKEN, { useValue: { appName: 'demo', port: 3000 } satisfies AppConfig });

const users = container.resolve(UserService);

console.log('graph resolved from constructor metadata only:');
console.log(' ', users.greet(1));
console.log('singleton:', container.resolve(UserService) === container.resolve(UserService));
console.log('transient:', container.resolve(RequestId) === container.resolve(RequestId));
console.log('ids:', container.resolve(RequestId).value, container.resolve(RequestId).value);
