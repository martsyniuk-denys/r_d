import { Controller } from '../decorators/controller';
import { Get } from '../decorators/methods';
import { UsersService } from '../services/users.service';

@Controller('context')
export class ContextController {
  constructor(private readonly users: UsersService) {}

  @Get()
  show(): Promise<{ requestId: string; seenBy: string; users: number }> {
    return this.users.describeRequest();
  }
}
