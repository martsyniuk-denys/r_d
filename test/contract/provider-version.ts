import { execSync } from 'node:child_process';

/**
 * The version the verification result is published under, and the one the prod
 * tag has to be put on — can-i-deploy answers "unknown" if the two differ.
 * Deterministic on a clean checkout, overridable for CI.
 */
export function providerVersion(): string {
  const fromEnv = process.env.PACT_PROVIDER_VERSION;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;

  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '0.0.0-local';
  }
}
