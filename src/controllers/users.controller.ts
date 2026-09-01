import { Controller } from '../decorators/controller';
import { Get, Post } from '../decorators/methods';
import { Body, Param, Query } from '../decorators/params';
import { UseGuards } from '../decorators/use';
import { createUserSchema, type CreateUserDto } from '../dto/create-user.dto';
import { AuthGuard } from '../guards/auth.guard';
import { UsersService } from '../services/users.service';
import type { User } from '../services/users.service';

@Controller('users')
@UseGuards(AuthGuard)
export class UsersController {
  constructor(readonly users: UsersService) {}

  @Get()
  findAll(@Query('limit') limit?: number): User[] {
    return this.users.findAll(limit);
  }

  @Get(':id')
  findOne(@Param('id') id: number): User {
    return this.users.findOne(id);
  }

  @Post()
  create(@Body(createUserSchema) dto: CreateUserDto): User {
    return this.users.create(dto);
  }
}
