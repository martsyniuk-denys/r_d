import { Injectable } from '../decorators/injectable';
import { CreateUserDto } from '../dto/create-user.dto';
import { HttpError } from '../errors';

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

  findAll(limit?: number): User[] {
    const all = [...this.users.values()];
    return limit === undefined ? all : all.slice(0, limit);
  }

  findOne(id: number): User {
    const user = this.users.get(id);

    if (!user) {
      throw new HttpError(404, `User ${id} not found`);
    }

    return user;
  }

  create(dto: CreateUserDto): User {
    const user: User = { id: this.nextId, name: dto.name, email: dto.email, age: dto.age };

    this.users.set(this.nextId, user);
    this.nextId += 1;

    return user;
  }
}
