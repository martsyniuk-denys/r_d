import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

// scrypt from node:crypto with its default cost (N = 16384, r = 8, p = 1) and a
// per-user salt, stored as scrypt$<salt>$<hash>. No new dependency for something
// the standard library already does.
const KEY_LENGTH = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

// A hash to compare against when the email is unknown, so "no such user" and
// "wrong password" cost the same time and cannot be told apart by a stopwatch.
const DUMMY = `scrypt$${randomBytes(16).toString('base64url')}$${randomBytes(KEY_LENGTH).toString('base64url')}`;

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const [scheme, salt, expected] = (stored ?? DUMMY).split('$');
  if (scheme !== 'scrypt' || salt === undefined || expected === undefined) return false;

  const actual = await scrypt(password, Buffer.from(salt, 'base64url'), KEY_LENGTH);
  const wanted = Buffer.from(expected, 'base64url');
  return stored !== null && actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
