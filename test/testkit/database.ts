import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pool } from 'pg';

// globalSetup and the workers are different processes, so the container's URI
// travels in an environment variable with a file as the fallback.
export const HANDOFF = join(tmpdir(), 'marketplace-testcontainer.url');

export function publishConnectionUri(uri: string): void {
  process.env.DATABASE_URL = uri;
  writeFileSync(HANDOFF, uri, 'utf8');
}

export function connectionUri(): string {
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;

  try {
    return readFileSync(HANDOFF, 'utf8').trim();
  } catch {
    throw new Error(
      'No DATABASE_URL and no handoff file — the testcontainer never started. ' +
        'Run this suite through its npm script so jest globalSetup runs first.',
    );
  }
}

export function testPool(): Pool {
  return new Pool({ connectionString: connectionUri(), max: 4 });
}

// The application reads a URL without a password plus a password file (#11), so
// the container's generated password is written where the app expects to find it.
export function appEnvFromContainer(): void {
  const uri = new URL(connectionUri());
  const dir = mkdtempSync(join(tmpdir(), 'marketplace-test-'));
  const passwordFile = join(dir, 'db_password');
  writeFileSync(passwordFile, decodeURIComponent(uri.password), 'utf8');

  uri.password = '';
  process.env.DB_URL = uri.toString();
  process.env.DB_PASSWORD_FILE = passwordFile;
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error';
}
