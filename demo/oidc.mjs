// npm run demo:oidc
//
// The OIDC gate of the pipeline (scripts/oidc-gate.mjs), run on three tokens signed
// here and now — a real GitHub token lives minutes and never enters the repository.
//
//   1. an RSA key pair is generated for this run only;
//   2. a local issuer is served on 127.0.0.1: /.well-known/openid-configuration and
//      the JWKS with the public half — the same discovery path the gate takes in CI;
//   3. three tokens are signed:
//        green          sub the policy allows, correct aud, correct signature
//        foreign-sub    correct signature and aud, sub of somebody else's repository
//        bad-signature  the payload of green under a corrupted signature
//   4. the unchanged gate runs on each, with the issuer passed as a parameter and the
//      subjects taken from the real oidc/policy.json.
//
// Expected sig-verified / policy-allow: green 1 1 · foreign-sub 1 0 · bad-signature 0 0.
// Exit 0 when exactly that came out.

import { execFile } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const POLICY = join(ROOT, 'oidc', 'policy.json');
const GATE = join(ROOT, 'scripts', 'oidc-gate.mjs');
const policy = JSON.parse(readFileSync(POLICY, 'utf8'));

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = randomUUID();
const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };

const server = createServer((req, res) => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const body =
    req.url === '/.well-known/openid-configuration'
      ? { issuer: base, jwks_uri: `${base}/.well-known/jwks` }
      : req.url === '/.well-known/jwks'
        ? { keys: [jwk] }
        : null;
  res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body ?? { error: 'not found' }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const issuer = `http://127.0.0.1:${server.address().port}`;

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
function signJwt(claims) {
  const input = `${b64({ alg: 'RS256', typ: 'JWT', kid })}.${b64(claims)}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}

const now = Math.floor(Date.now() / 1000);
const claims = (sub) => ({
  iss: issuer,
  aud: policy.audience,
  sub,
  iat: now,
  nbf: now - 5,
  exp: now + 300,
  jti: randomUUID(),
});

const green = signJwt(claims(policy.subjects[0]));
const [h, p, s] = green.split('.');
const sig = Buffer.from(s, 'base64url');
sig[sig.length - 1] ^= 0xff; // one flipped byte: same header, same payload, wrong signature
const cases = {
  green,
  // same owner name, same environment — only the repository differs
  'foreign-sub': signJwt(claims('repo:somebody-else/r_d:environment:kind')),
  'bad-signature': `${h}.${p}.${sig.toString('base64url')}`,
};

const work = mkdtempSync(join(tmpdir(), 'oidc-demo-'));
const run = promisify(execFile);
const expected = { green: [1, 1], 'foreign-sub': [1, 0], 'bad-signature': [0, 0] };
let asExpected = true;

try {
  for (const [name, token] of Object.entries(cases)) {
    const file = join(work, `${name}.jwt`);
    writeFileSync(file, token, { mode: 0o600 });
    let stdout;
    let code = 0;
    try {
      ({ stdout } = await run(process.execPath, [GATE, '--token-file', file, '--policy', POLICY, '--issuer', issuer]));
    } catch (err) {
      ({ stdout } = err);
      code = err.code;
    }
    const out = Object.fromEntries(
      stdout.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    console.log(`case=${name}`);
    process.stdout.write(stdout);
    console.log(`gate-exit=${code}`);
    console.log('');
    const [sv, pa] = expected[name];
    if (Number(out['sig-verified']) !== sv || Number(out['policy-allow']) !== pa) asExpected = false;
  }
} finally {
  rmSync(work, { recursive: true, force: true });
  server.close();
}

console.log(`as-expected=${asExpected ? 1 : 0}`);
process.exit(asExpected ? 0 : 1);
