import 'reflect-metadata';

export { Container } from './container';
export { Injectable } from './decorators/injectable';
export { Inject } from './decorators/inject';
export { Controller } from './decorators/controller';
export { Get, Post } from './decorators/methods';
export { Body, Param, Query } from './decorators/params';
export { UseGuards, UseInterceptors } from './decorators/use';
export { Dispatcher, type DispatcherOptions } from './dispatcher';
export { Router, joinPath, splitPath, type Route, type RouteMatch } from './router';
export { send } from './response';

export {
  RequestContext,
  createRequestStore,
  getRequestId,
  resolveRequestId,
  type RequestStore,
} from './context/request-context';
export { RequestIdMiddleware } from './middleware/request-id.middleware';
export { AuthGuard } from './guards/auth.guard';
export { LoggingInterceptor, type LogSink } from './interceptors/logging.interceptor';
export { ZodValidationPipe } from './pipes/zod-validation.pipe';
export { HttpExceptionFilter, type ErrorBody, type ErrorSink } from './filters/exception.filter';

export type {
  ArgumentMetadata,
  CallHandler,
  CanActivate,
  Component,
  ExceptionFilter,
  ExecutionContext,
  Interceptor,
  Middleware,
  PipeTransform,
} from './lifecycle';

export { createUserSchema, type CreateUserDto } from './dto/create-user.dto';
export { ContextController } from './controllers/context.controller';
export { HealthController } from './controllers/health.controller';
export { UsersController } from './controllers/users.controller';
export { AuditService, type AuditEntry } from './services/audit.service';
export { UsersService, type User } from './services/users.service';
export {
  CircularDependencyError,
  ForbiddenError,
  HttpError,
  NotFoundError,
  ResolutionError,
  ValidationError,
  type FieldError,
} from './errors';
export {
  CONTROLLER_METADATA,
  GUARDS_METADATA,
  INJECTABLE_METADATA,
  INJECT_METADATA,
  INTERCEPTORS_METADATA,
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
