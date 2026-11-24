// The broken input of step 1 (types and style), fed to scripts/gates/types.sh by
// demo:gates. Not part of src/: nothing builds or imports it. Two real defects of
// the classes the step exists for:

import type { Env } from '../../../src/config/env.schema';

// a typo in a type: the field is PORT, and it is a number, not a string
export function listenPort(env: Env): string {
  return env.PROT;
}

// a style defect a type checker accepts: loose equality
export function isDefaultPort(env: Env): boolean {
  return env.PORT == 3000;
}
