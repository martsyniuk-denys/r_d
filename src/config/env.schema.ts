import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  DB_URL: z
    .string()
    .min(1)
    .refine((v) => /^postgres(ql)?:\/\//.test(v), {
      message: 'must be a postgres:// connection string',
    })
    .refine((v) => !/:[^@/]*@/.test(v.replace(/^postgres(ql)?:\/\//, '')), {
      message: 'must not contain a password — the password is read from DB_PASSWORD_FILE',
    }),

  DB_PASSWORD_FILE: z.string().min(1).default('./secrets/db_password'),

  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(100).default(5000),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

export function validate(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);

  if (parsed.success) return parsed.data;

  const lines = parsed.error.issues.map((issue) => {
    const name = issue.path.join('.') || '(root)';
    const received = raw[name];
    const seen =
      received === undefined
        ? 'not set'
        : `received ${JSON.stringify(String(received).slice(0, 60))}`;
    return `  - ${name}: ${issue.message} (${seen})`;
  });

  throw new Error(
    `Invalid environment configuration — ${parsed.error.issues.length} problem(s):\n${lines.join('\n')}\n\n` +
      'Every variable is documented in .env.example. Fix the values above and start again.',
  );
}
