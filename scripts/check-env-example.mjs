import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { envSchema } from '../dist/config/env.schema.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE = join(ROOT, '.env.example');

const problems = [];

const lines = readFileSync(EXAMPLE, 'utf8').split('\n');

const documented = new Map();
let commentAbove = false;

for (const raw of lines) {
  const line = raw.trim();
  if (line === '') {
    commentAbove = false;
    continue;
  }
  if (line.startsWith('#')) {
    commentAbove = true;
    continue;
  }
  const eq = line.indexOf('=');
  if (eq === -1) {
    problems.push(`.env.example: line is neither a comment nor KEY=VALUE: ${line}`);
    continue;
  }
  const key = line.slice(0, eq).trim();
  documented.set(key, line.slice(eq + 1).trim());
  if (!commentAbove) problems.push(`${key}: present in .env.example but has no comment above it`);
  commentAbove = false;
}

const schemaKeys = Object.keys(envSchema.shape);

for (const key of schemaKeys) {
  if (!documented.has(key)) problems.push(`${key}: in the schema but missing from .env.example`);
}

for (const key of documented.keys()) {
  if (!schemaKeys.includes(key)) problems.push(`${key}: in .env.example but not in the schema`);
}

const parsed = envSchema.safeParse(Object.fromEntries(documented));
if (!parsed.success) {
  for (const issue of parsed.error.issues) {
    problems.push(`${issue.path.join('.') || '(root)'}: value in .env.example is invalid — ${issue.message}`);
  }
}

if (problems.length > 0) {
  console.error(`.env.example is out of sync with src/config/env.schema.ts — ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nUpdate .env.example so it documents exactly the variables the schema defines.');
  process.exit(1);
}

console.log(`.env.example is in sync with the schema — ${schemaKeys.length} variables, each documented.`);
