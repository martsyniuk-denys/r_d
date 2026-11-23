import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The `keys` one-shot of docker-compose.yml: the store of the compose environment.
// It writes the secrets the API refuses to start without into KEYS_DIR (a named
// volume), one file per variable, and the API reads them through NAME_FILE (see
// src/config/secret-files.ts). Nothing here is in git, in the image or in compose.
//
// Generated once: a file that exists is kept. A second `up` therefore keeps the
// signing key, so tokens and refresh sessions survive a restart; a new key is
// `docker compose down -v`, which also drops the database they point into.

const DIR = process.env.KEYS_DIR ?? '/keys';

function signingKey(): Record<string, string> {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return {
    // Base64 PEMs: the shape the env schema takes from the environment.
    JWT_PRIVATE_KEY: Buffer.from(privateKey).toString('base64'),
    JWT_PUBLIC_KEY: Buffer.from(publicKey).toString('base64'),
    JWT_KID: `compose-${new Date().toISOString().slice(0, 10)}-${randomBytes(3).toString('hex')}`,
  };
}

function main(): void {
  const written: string[] = [];
  const write = (values: Record<string, string>): void => {
    for (const [name, value] of Object.entries(values)) {
      writeFileSync(join(DIR, name), `${value}\n`, { mode: 0o600 });
      written.push(name);
    }
  };

  // The three halves of the signing key go together or not at all.
  if (!existsSync(join(DIR, 'JWT_PRIVATE_KEY'))) write(signingKey());
  if (!existsSync(join(DIR, 'REFRESH_TOKEN_PEPPER'))) {
    write({ REFRESH_TOKEN_PEPPER: randomBytes(32).toString('base64url') });
  }
  if (!existsSync(join(DIR, 'PAYMENT_WEBHOOK_SECRET'))) {
    write({ PAYMENT_WEBHOOK_SECRET: randomBytes(32).toString('hex') });
  }

  // Names only — never a value.
  console.log(
    JSON.stringify({ kind: 'keys', dir: DIR, written, kept: written.length === 0 ? 'all' : undefined }),
  );
}

main();
