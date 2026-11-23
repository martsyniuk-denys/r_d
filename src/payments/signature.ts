import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-signature';
const SCHEME = 'sha256=';

// HMAC-SHA256 over the raw request body, hex, as the header value "sha256=<hex>".
// The provider side (scripts and demos) and the check below share this function.
export function sign(rawBody: Buffer | string, secret: string): string {
  return SCHEME + createHmac('sha256', secret).update(rawBody).digest('hex');
}

// Constant-time: a byte-by-byte === leaks how many leading characters of a forged
// signature were right. Lengths are compared first because timingSafeEqual throws
// on a mismatch — and the length of a hex SHA-256 is no secret.
export function verify(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (header === undefined || !header.startsWith(SCHEME)) return false;
  const expected = Buffer.from(sign(rawBody, secret), 'utf8');
  const received = Buffer.from(header, 'utf8');
  return expected.length === received.length && timingSafeEqual(expected, received);
}
