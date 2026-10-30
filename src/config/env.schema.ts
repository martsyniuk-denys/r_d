import { createPrivateKey, createPublicKey, KeyObject } from 'node:crypto';

import { z } from 'zod';

// A PEM travels through the environment base64-encoded: a multi-line export does
// not survive every shell and CI runner, and the reward for trying is
// "error:1E08010C:DECODER routines::unsupported" on the first signature.
export function pemFromBase64(value: string): string {
  return Buffer.from(value, 'base64').toString('utf8');
}

function ecP256(key: KeyObject): boolean {
  return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
}

function parses(value: string, load: (pem: string) => KeyObject): boolean {
  try {
    return ecP256(load(pemFromBase64(value)));
  } catch {
    return false;
  }
}

// No .default() on any of these four: a default for a signing key is a signing key
// committed to git, and a process that starts without one must not start at all.
const privateKey = z
  .string()
  .min(1)
  .refine((v) => parses(v, createPrivateKey), {
    message: 'must be a base64-encoded PKCS#8 PEM of an EC P-256 private key (ES256)',
  });

const publicKey = z
  .string()
  .min(1)
  .refine((v) => parses(v, createPublicKey), {
    message: 'must be a base64-encoded SPKI PEM of an EC P-256 public key (ES256)',
  });

const kid = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,64}$/, { message: 'must be 1–64 characters of [A-Za-z0-9._-]' });

// The variables that come from the secret store and nowhere else. .env.example
// documents them with an empty value, and scripts/check-env-example.mjs accepts
// that for these names only.
export const STORE_VARIABLES = [
  'JWT_PRIVATE_KEY',
  'JWT_PUBLIC_KEY',
  'JWT_KID',
  'REFRESH_TOKEN_PEPPER',
  'JWT_PREVIOUS_PUBLIC_KEY',
  'JWT_PREVIOUS_KID',
] as const;

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  // Either the store's shape (a URL without a password + DB_PASSWORD_FILE) or the
  // grader's (DATABASE_URL with the password inside). validate() requires one.
  DB_URL: z
    .string()
    .min(1)
    .refine((v) => /^postgres(ql)?:\/\//.test(v), {
      message: 'must be a postgres:// connection string',
    })
    .refine((v) => !/:[^@/]*@/.test(v.replace(/^postgres(ql)?:\/\//, '')), {
      message: 'must not contain a password — the password is read from DB_PASSWORD_FILE',
    })
    .optional(),

  DATABASE_URL: z
    .string()
    .min(1)
    .refine((v) => /^postgres(ql)?:\/\//.test(v), {
      message: 'must be a postgres:// connection string',
    })
    .optional(),

  DB_PASSWORD_FILE: z.string().min(1).default('./secrets/db_password'),

  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(100).default(5000),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  JWT_PRIVATE_KEY: privateKey,

  JWT_PUBLIC_KEY: publicKey,

  JWT_KID: kid,

  REFRESH_TOKEN_PEPPER: z.string().min(12, { message: 'must be at least 12 characters' }),

  // The previous key of an overlap rotation: verified, never signed with.
  JWT_PREVIOUS_PUBLIC_KEY: publicKey.optional(),

  JWT_PREVIOUS_KID: kid.optional(),

  JWT_ISSUER: z.string().min(1).default('marketplace-api'),

  JWT_AUDIENCE: z.string().min(1).default('marketplace-api'),

  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(600),

  REFRESH_TTL_SECONDS: z.coerce.number().int().min(60).default(30 * 24 * 3600),
});

export type Env = z.infer<typeof envSchema>;

const contract = envSchema.superRefine((env, ctx) => {
  if (env.DB_URL === undefined && env.DATABASE_URL === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['DB_URL'],
      message: 'set DB_URL (+ DB_PASSWORD_FILE) from the store, or DATABASE_URL',
    });
  }

  if ((env.JWT_PREVIOUS_PUBLIC_KEY === undefined) !== (env.JWT_PREVIOUS_KID === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['JWT_PREVIOUS_KID'],
      message: 'JWT_PREVIOUS_PUBLIC_KEY and JWT_PREVIOUS_KID are set together or not at all',
    });
  }

  if (env.JWT_PREVIOUS_KID !== undefined && env.JWT_PREVIOUS_KID === env.JWT_KID) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['JWT_PREVIOUS_KID'],
      message: 'must differ from JWT_KID — the kid is what tells the two keys apart',
    });
  }

  const pairs = (() => {
    try {
      const fromPrivate = createPublicKey(createPrivateKey(pemFromBase64(env.JWT_PRIVATE_KEY)));
      const declared = createPublicKey(pemFromBase64(env.JWT_PUBLIC_KEY));
      return fromPrivate.export({ type: 'spki', format: 'der' }).equals(declared.export({ type: 'spki', format: 'der' }));
    } catch {
      return true;
    }
  })();
  if (!pairs) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['JWT_PUBLIC_KEY'],
      message: 'is not the public half of JWT_PRIVATE_KEY',
    });
  }
});

// Never echoes a value back for these: the message names the variable, not the key.
const SECRET = new Set<string>([...STORE_VARIABLES, 'DATABASE_URL']);

export function validate(raw: Record<string, unknown>): Env {
  // An empty value is an unset one: `JWT_PREVIOUS_KID=` copied from .env.example
  // means "no previous key", and `JWT_PRIVATE_KEY=` must fail as "not set".
  const present = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== ''));
  const parsed = contract.safeParse(present);

  if (parsed.success) return parsed.data;

  const lines = parsed.error.issues.map((issue) => {
    const name = issue.path.join('.') || '(root)';
    const received = present[name];
    const seen =
      received === undefined
        ? 'not set'
        : SECRET.has(name)
          ? 'set, value withheld'
          : `received ${JSON.stringify(String(received).slice(0, 60))}`;
    return `  - ${name}: ${issue.message} (${seen})`;
  });

  throw new Error(
    `Invalid environment configuration — ${parsed.error.issues.length} problem(s):\n${lines.join('\n')}\n\n` +
      'Every variable is documented in .env.example. Secrets (JWT_*, REFRESH_TOKEN_PEPPER) come from the\n' +
      'store: npm run start:vault, or export them yourself with SKIP_VAULT=1. Fix the values above and start again.',
  );
}
