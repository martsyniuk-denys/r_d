import 'reflect-metadata';

export { Container } from './container';
export { Injectable } from './decorators/injectable';
export { Inject } from './decorators/inject';
export { Controller } from './decorators/controller';
export { Get, Post } from './decorators/methods';
export { Body, Param, Query } from './decorators/params';
export { Dispatcher } from './dispatcher';
export { Router, joinPath, splitPath, type Route, type RouteMatch } from './router';
export { ValidationPipe } from './pipes/validation.pipe';
export { CreateUserDto } from './dto/create-user.dto';
export { HealthController } from './controllers/health.controller';
export { UsersController } from './controllers/users.controller';
export { UsersService, type User } from './services/users.service';
export {
  CircularDependencyError,
  HttpError,
  ResolutionError,
  ValidationFailedError,
  type FieldError,
} from './errors';
export {
  CONTROLLER_METADATA,
  INJECTABLE_METADATA,
  INJECT_METADATA,
  PARAMS_METADATA,
  ROUTES_METADATA,
  SCOPE_METADATA,
  describeToken,
  type Constructor,
  type HttpMethod,
  type InjectableOptions,
  type ParamDefinition,
  type ParamMap,
  type Provider,
  type RouteMetadata,
  type Scope,
  type Token,
} from './metadata';
export { CONFIG_TOKEN, LOGGER_TOKEN, type AppConfig, type Logger } from './tokens';
