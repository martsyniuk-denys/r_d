'use strict';

/**
 * Прогін acceptance-критеріїв по самій спеці (пункти 1-4 ДЗ).
 * Те саме, що й команди з умови, але одним запуском: npm run check
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SPEC_YAML = path.join(ROOT, 'openapi', 'openapi.yaml');
const SPEC_JSON = path.join(ROOT, 'spec.json');

let failed = 0;
const check = (label, ok, actual) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${actual === undefined ? '' : ` → ${actual}`}`);
  if (!ok) failed++;
};

const redocly = (...args) =>
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules', '@redocly', 'cli', 'bin', 'cli.js'), ...args], {
    cwd: ROOT,
    stdio: 'pipe',
  });

console.log('\n1. redocly lint');
try {
  redocly('lint', 'openapi/openapi.yaml');
  check('спека валідна (exit code 0)', true);
} catch (e) {
  check('спека валідна (exit code 0)', false, String(e.stdout || e.message).slice(-500));
}

console.log('\n2. Обсяг спеки');
redocly('bundle', 'openapi/openapi.yaml', '-o', 'spec.json');
const spec = JSON.parse(fs.readFileSync(SPEC_JSON, 'utf8'));
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const ops = Object.entries(spec.paths).flatMap(([p, v]) =>
  Object.keys(v).filter((m) => METHODS.includes(m)).map((m) => [p, m]),
);
const resources = new Set(Object.keys(spec.paths).map((p) => p.split('/')[1]));
check('операцій ≥ 5', ops.length >= 5, ops.length);
check('ресурсів ≥ 2', resources.size >= 2, [...resources].join(', '));

console.log('\n3. Idempotency-Key');
const idem = ops
  .flatMap(([p, m]) => spec.paths[p][m].parameters ?? [])
  .find((x) => x.in === 'header' && /idempotency-key/i.test(x.name));
check('header-параметр присутній', Boolean(idem), idem?.name);
check('required = true', idem?.required === true);
check('опис ≥ 40 символів', (idem?.description ?? '').trim().length >= 40, `${(idem?.description ?? '').trim().length} символів`);

console.log('\n4. Grep-критерії по openapi/openapi.yaml');
const yaml = fs.readFileSync(SPEC_YAML, 'utf8');
const countOf = (needle) => yaml.split('\n').filter((l) => l.includes(needle)).length;
check("grep -c 'Idempotency-Key' ≥ 1", countOf('Idempotency-Key') >= 1, countOf('Idempotency-Key'));
check("grep -c 'next_cursor' ≥ 1", countOf('next_cursor') >= 1, countOf('next_cursor'));
check("grep -c 'application/problem+json' ≥ 2", countOf('application/problem+json') >= 2, countOf('application/problem+json'));

console.log('\n5. Cursor-пагінація у спискових операціях');
for (const [p, m] of ops) {
  const op = spec.paths[p][m];
  const isList = m === 'get' && !p.includes('{');
  if (!isList) continue;
  const names = (op.parameters ?? []).map((x) => x.name);
  const schemaRef = op.responses['200'].content['application/json'].schema.$ref;
  const pageSchema = spec.components.schemas[schemaRef.split('/').pop()];
  check(`${m.toUpperCase()} ${p}: query cursor + limit`, names.includes('cursor') && names.includes('limit'), names.join(', '));
  check(
    `${m.toUpperCase()} ${p}: items + next_cursor (nullable)`,
    Boolean(pageSchema.properties.items) && pageSchema.properties.next_cursor?.nullable === true,
  );
}

console.log('\n6. Схема Problem');
const problem = spec.components?.schemas?.Problem;
check('components.schemas.Problem існує', Boolean(problem));
for (const field of ['type', 'title', 'status', 'detail', 'instance']) {
  check(`Problem.${field} обовʼязкове`, (problem?.required ?? []).includes(field));
}

console.log(failed === 0 ? '\n✅ Усі перевірки спеки пройдено\n' : `\n❌ Провалено перевірок: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
