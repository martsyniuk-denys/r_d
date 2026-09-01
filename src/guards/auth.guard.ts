import { Injectable } from '../decorators/injectable';
import type { CanActivate, ExecutionContext } from '../lifecycle';

const BEARER = /^Bearer\s+\S+$/i;

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const header = context.req.headers.authorization;

    return typeof header === 'string' && BEARER.test(header.trim());
  }
}
