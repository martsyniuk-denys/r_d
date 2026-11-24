import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadSecretFiles } from '../../src/config/secret-files';

describe('secrets from NAME_FILE', () => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-files-'));
  writeFileSync(join(dir, 'pepper'), 'from-the-keys-volume\n');

  it('reads the value of a store variable from the file, trimmed', () => {
    const env: NodeJS.ProcessEnv = { REFRESH_TOKEN_PEPPER_FILE: join(dir, 'pepper') };
    loadSecretFiles(env);
    expect(env.REFRESH_TOKEN_PEPPER).toBe('from-the-keys-volume');
  });

  it('keeps a value that is already in the environment', () => {
    const env: NodeJS.ProcessEnv = { REFRESH_TOKEN_PEPPER: 'exported', REFRESH_TOKEN_PEPPER_FILE: join(dir, 'pepper') };
    loadSecretFiles(env);
    expect(env.REFRESH_TOKEN_PEPPER).toBe('exported');
  });

  it('names both variables when the file is missing, and never a value', () => {
    const env: NodeJS.ProcessEnv = { JWT_PRIVATE_KEY_FILE: join(dir, 'absent') };
    expect(() => loadSecretFiles(env)).toThrow(/JWT_PRIVATE_KEY_FILE .* \(ENOENT\) — JWT_PRIVATE_KEY stays unset/);
  });

  it('ignores variables outside the store', () => {
    const env: NodeJS.ProcessEnv = { DB_URL_FILE: join(dir, 'pepper') };
    loadSecretFiles(env);
    expect(env.DB_URL).toBeUndefined();
  });
});
