import { createHash, createPrivateKey, createPublicKey, KeyObject } from 'node:crypto';

import { ConfigService } from '@nestjs/config';

import { Env, pemFromBase64 } from '../config/env.schema';

// The one asymmetric algorithm this service signs and accepts. It is passed to
// jwt.verify() as an explicit allowlist (RFC 8725 §3.1), so a token that says
// "alg": "none" or "HS256" in its header is rejected before its header is believed.
export const ALGORITHM = 'ES256' as const;

// SHA-256 over the DER of the public key. Safe to print and to log: it identifies
// a key without being one, so two environments can be compared by eye.
export function fingerprint(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return `sha256:${createHash('sha256').update(der).digest('hex').slice(0, 32)}`;
}

// The current key signs; the previous one, during an overlap rotation, is only
// verified. The kid in the token header picks the key, so tokens signed before
// the rotation keep working until they expire, and no longer.
export class KeyRing {
  private constructor(
    readonly kid: string,
    readonly privateKey: KeyObject,
    private readonly verifiers: ReadonlyMap<string, KeyObject>,
  ) {}

  static fromConfig(config: ConfigService<Env, true>): KeyRing {
    const kid = config.get('JWT_KID', { infer: true });
    const verifiers = new Map<string, KeyObject>([
      [kid, createPublicKey(pemFromBase64(config.get('JWT_PUBLIC_KEY', { infer: true })))],
    ]);

    const previousKid = config.get('JWT_PREVIOUS_KID', { infer: true });
    const previousKey = config.get('JWT_PREVIOUS_PUBLIC_KEY', { infer: true });
    if (previousKid !== undefined && previousKey !== undefined) {
      verifiers.set(previousKid, createPublicKey(pemFromBase64(previousKey)));
    }

    return new KeyRing(kid, createPrivateKey(pemFromBase64(config.get('JWT_PRIVATE_KEY', { infer: true }))), verifiers);
  }

  verifierFor(kid: unknown): KeyObject | undefined {
    return typeof kid === 'string' ? this.verifiers.get(kid) : undefined;
  }

  describe(): string {
    return [...this.verifiers.entries()]
      .map(([kid, key]) => `${kid}${kid === this.kid ? ' (signing)' : ' (verify only)'} ${fingerprint(key)}`)
      .join(', ');
  }
}
