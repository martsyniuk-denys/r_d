import { readFileSync } from 'node:fs';

import { STORE_VARIABLES } from './env.schema';

// The container's way into the store: NAME_FILE names a file that holds the value of
// NAME. Compose mounts the keys volume (written once by the `keys` one-shot) and sets
// JWT_PRIVATE_KEY_FILE=/keys/JWT_PRIVATE_KEY and so on, so a signing key is never an
// environment value in a compose file, an image layer or `docker inspect`.
//
// A value already in the environment wins, the same rule as for .env. A NAME_FILE
// that points at nothing is an error that names both variables: silently starting
// without the key would only move the failure to the schema with a worse message.
export function loadSecretFiles(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of STORE_VARIABLES) {
    const file = env[`${name}_FILE`];
    if (file === undefined || file === '' || (env[name] ?? '') !== '') continue;

    try {
      env[name] = readFileSync(file, 'utf8').trim();
    } catch (error) {
      const reason = (error as NodeJS.ErrnoException).code ?? 'unreadable';
      throw new Error(`${name}_FILE points at ${file}, which cannot be read (${reason}) — ${name} stays unset.`);
    }
  }
}
