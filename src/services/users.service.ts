import { setTimeout as delay } from 'node:timers/promises';

import { Injectable } from '../decorators/injectable';
import { NotFoundError } from '../errors';
import type { CreateUserDto } from '../dto/create-user.dto';
import { AuditService } from './audit.service';

export interface User {
  id: number;
  name: string;
  email: string;
  age?: number;
}

@Injectable()
export class UsersService {
  private readonly users = new Map<number, User>([
    [1, { id: 1, name: 'Ada Lovelace', email: 'ada@example.com', age: 36 }],
    [42, { id: 42, name: 'Grace Hopper', email: 'grace@example.com', age: 85 }],
  ]);

  private nextId = 43;

  constructor(private readonly audit: AuditService) {}

  findAll(limit?: number): User[] {
    this.audit.record('users.findAll');

    const all = [...this.users.values()];

    return limit === undefined ? all : all.slice(0, limit);
  }

  findOne(id: number): User {
    this.audit.record('users.findOne');

    const user = this.users.get(id);

    if (!user) {
      throw new NotFoundError(`User ${id} not found`);
    }

    return user;
  }

  create(dto: CreateUserDto): User {
    this.audit.record('users.create');

    const user: User = { id: this.nextId, name: dto.name, email: dto.email, age: dto.age };

    this.users.set(this.nextId, user);
    this.nextId += 1;

    return user;
  }

  async describeRequest(): Promise<{ requestId: string; seenBy: string; users: number }> {
    await delay(Math.floor(Math.random() * 20));

    const entry = this.audit.record('users.describeRequest');

    return { requestId: entry.requestId, seenBy: 'AuditService', users: this.users.size };
  }
}
