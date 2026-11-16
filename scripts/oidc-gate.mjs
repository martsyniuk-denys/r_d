// The OIDC gate in front of the deploy job: verify the signature of an ID token
// against the issuer's published keys, then apply the trust condition of a policy
// file. Prints the claims it decided on — iss, aud, sub — never the token.
//
//   node scripts/oidc-gate.mjs --token-file <jwt> --policy oidc/policy.json \
//        [--issuer <url>] [--audience <aud>] [--jwks-uri <url>]
//
// --issuer and --audience default to the policy's; the key set is found the way a
// cloud finds it: <issuer>/.well-known/openid-configuration → jwks_uri, unless
// --jwks-uri names it. Nothing here knows whether it runs in CI or in demo:oidc.
//
// Output (key=value):
//   iss, aud, sub       the token's claims (read before verification, printed as-is)
//   sig-verified        1 when an RS256 signature checks out against a key of the set
//   iss-ok aud-ok time-ok sub-ok   the parts of the condition
//   policy-allow        1 only when the signature AND every part of the condition hold
// Exit 0 when policy-allow=1, 1 when denied, 2 when the gate could not run.

import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const SKEW_SECONDS = 60;

const { values } = parseArgs({
  options: {
    'token-file': { type: 'string' },
    policy: { type: 'string' },
    issuer: { type: 'string' },
    audience: { type: 'string' },
    'jwks-uri': { type: 'string' },
  },
});

function fail(message) {
  console.error(`oidc-gate: ${message}`);
  process.exit(2);
}

if (!values['token-file'] || !values.policy) {
  fail('usage: --token-file <jwt> --policy <policy.json> [--issuer <url>] [--audience <aud>] [--jwks-uri <url>]');
}

const policy = JSON.parse(readFileSync(values.policy, 'utf8'));
const issuer = values.issuer ?? policy.issuer;
const audience = values.audience ?? policy.audience;
const subjects = policy.subjects;
if (!issuer || !audience || !Array.isArray(subjects) || subjects.length === 0) {
  fail('the policy needs issuer, audience and a non-empty subjects list');
}

const token = readFileSync(values['token-file'], 'utf8').trim();
const parts = token.split('.');
if (parts.length !== 3) fail('the token is not a compact JWS (three dot-separated parts)');
const [headerB64, payloadB64, signatureB64] = parts;

const decode = (b64) => JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
let header;
let claims;
try {
  header = decode(headerB64);
  claims = decode(payloadB64);
} catch {
  fail('the token header or payload is not base64url JSON');
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) fail(`GET ${url} answered ${res.status}`);
  return res.json();
}

let jwksUri = values['jwks-uri'];
if (!jwksUri) {
  const discovery = await getJson(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
  // The document must describe the issuer we expect, or its keys mean nothing here.
  if (discovery.issuer !== issuer) fail(`openid-configuration names issuer ${discovery.issuer}, expected ${issuer}`);
  jwksUri = discovery.jwks_uri;
}
const { keys = [] } = await getJson(jwksUri);

// Only RS256 is accepted: "none" and HS* (an HMAC keyed with a public key) are the
// classic ways to have a signature "verify" without the issuer's private key.
let sigVerified = false;
if (header.alg === 'RS256') {
  const candidates = keys.filter((k) => k.kty === 'RSA' && (header.kid === undefined || k.kid === header.kid));
  for (const jwk of candidates) {
    try {
      const key = createPublicKey({ key: jwk, format: 'jwk' });
      if (verify('RSA-SHA256', Buffer.from(`${headerB64}.${payloadB64}`), key, Buffer.from(signatureB64, 'base64url'))) {
        sigVerified = true;
        break;
      }
    } catch {
      // a malformed key in the set verifies nothing; try the next one
    }
  }
}

const now = Math.floor(Date.now() / 1000);
const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
const issOk = claims.iss === issuer;
const audOk = auds.includes(audience);
const timeOk =
  typeof claims.exp === 'number' &&
  claims.exp + SKEW_SECONDS > now &&
  (claims.nbf === undefined || claims.nbf - SKEW_SECONDS <= now);
// Exact match, no patterns: the one line that tells this repository from any other.
const subOk = typeof claims.sub === 'string' && subjects.includes(claims.sub);
const allow = sigVerified && issOk && audOk && timeOk && subOk;

const flag = (b) => (b ? 1 : 0);
console.log(`iss=${claims.iss}`);
console.log(`aud=${auds.join(',')}`);
console.log(`sub=${claims.sub}`);
console.log(`alg=${header.alg}`);
console.log(`jwks-uri=${jwksUri}`);
console.log(`sig-verified=${flag(sigVerified)}`);
console.log(`iss-ok=${flag(issOk)}`);
console.log(`aud-ok=${flag(audOk)}`);
console.log(`time-ok=${flag(timeOk)}`);
console.log(`sub-ok=${flag(subOk)}`);
console.log(`policy-allow=${flag(allow)}`);
process.exit(allow ? 0 : 1);
