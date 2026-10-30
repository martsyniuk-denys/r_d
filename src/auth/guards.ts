import { CanActivate, ExecutionContext, Injectable, SetMetadata, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';

import { forbidden, unauthorized } from '../common/problem';
import { UserRole } from '../entities/user.entity';
import { AuthService } from './auth.service';
import { Principal } from './principal';

// Authentication: "who is this?" — answered by cryptography. No token, a broken
// one, an expired one, a revoked one: 401, and a client SDK goes to refresh.
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();

    try {
      const match = /^Bearer ([A-Za-z0-9_\-.]+)$/.exec(req.headers.authorization ?? '');
      if (match === null) throw unauthorized('This resource needs an access token: Authorization: Bearer <token>.');
      req.principal = await this.auth.verifyAccess(match[1]);
      return true;
    } catch (error) {
      // RFC 6750 §3: a 401 for a bearer-protected resource names the scheme.
      res.setHeader('WWW-Authenticate', 'Bearer realm="marketplace"');
      throw error;
    }
  }
}

const ROLES = 'roles';

export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES, roles);

// Authorization at the level of a role: "may this kind of user do this at all?"
// Decided from the token alone, so it can be a guard. It runs after
// AccessTokenGuard, which is why there is always a principal here; a valid token
// with the wrong role is 403, and a client SDK shows an error instead of refreshing.
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const allowed = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowed === undefined) return true;

    const principal = context.switchToHttp().getRequest<Request>().principal;
    if (principal === undefined) throw unauthorized('No authenticated principal.');
    if (!allowed.includes(principal.role)) {
      throw forbidden(`Role '${principal.role}' may not do this; it needs one of: ${allowed.join(', ')}.`);
    }
    return true;
  }
}

export const CurrentPrincipal = createParamDecorator((_data: unknown, context: ExecutionContext): Principal => {
  const principal = context.switchToHttp().getRequest<Request>().principal;
  if (principal === undefined) throw unauthorized('No authenticated principal.');
  return principal;
});
