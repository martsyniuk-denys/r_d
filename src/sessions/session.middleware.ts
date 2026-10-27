import { NextFunction, Request, RequestHandler, Response } from 'express';

import { Session, SessionStore } from './session-store';

export const SESSION_COOKIE = 'sid';

declare module 'express-serve-static-core' {
  interface Request {
    session?: Session;
  }
}

function cookieValue(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

// Loads the session named by the cookie, or starts one. Every request through here
// renews the TTL in Redis, and the cookie is re-issued with the same id and a fresh
// Max-Age so both ends roll together.
export function sessionMiddleware(store: SessionStore): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = cookieValue(req, SESSION_COOKIE);
      const session = (id !== undefined ? await store.touch(id) : null) ?? (await store.create());

      req.session = session;
      res.cookie(SESSION_COOKIE, session.id, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: store.ttlSeconds * 1000,
      });
      next();
    } catch (error) {
      next(error);
    }
  };
}
