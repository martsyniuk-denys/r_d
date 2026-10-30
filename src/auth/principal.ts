import { UserRole } from '../entities/user.entity';

// What a verified access token says about its bearer. `role` is a copy taken at
// login or at the last refresh — a cache of users.role, not the source of truth.
export interface Principal {
  userId: string;
  role: UserRole;
  jti: string;
  familyId: string;
  expiresAt: number;
}

declare module 'express-serve-static-core' {
  interface Request {
    principal?: Principal;
  }
}
