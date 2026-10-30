// The signing keys and the refresh-token pepper of one environment, in the store:
//
//   secrets/jwt/<env>/private.pem   PKCS#8, EC P-256 (ES256)   never leaves the store
//   secrets/jwt/<env>/public.pem    SPKI
//   secrets/jwt/<env>/kid           the key id written into every token header
//   secrets/jwt/<env>/pepper        HMAC key for refresh_tokens.token_hash
//   secrets/jwt/<env>/previous/     public.pem + kid of the key being rotated out
//
// secrets/ is git-ignored; scripts/with-secrets.sh <env> exports these as
// JWT_PRIVATE_KEY / JWT_PUBLIC_KEY (base64 PEM), JWT_KID, REFRESH_TOKEN_PEPPER and,
// during an overlap, JWT_PREVIOUS_PUBLIC_KEY / JWT_PREVIOUS_KID.
//
//   node scripts/jwt-keys.mjs generate <env>     first key of an environment (refuses to overwrite)
//   node scripts/jwt-keys.mjs rotate <env>       new key; the old public key moves to previous/
//   node scripts/jwt-keys.mjs retire <env>       drop previous/ once the access TTL has passed
//   node scripts/jwt-keys.mjs fingerprint <env>  prints kid and fingerprint, never the key

import { createHash, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [command, env] = process.argv.slice(2);

if (!['generate', 'rotate', 'retire', 'fingerprint'].includes(command) || !/^[a-z0-9-]+$/.test(env ?? '')) {
  console.error('usage: node scripts/jwt-keys.mjs generate|rotate|retire|fingerprint <env>');
  process.exit(2);
}

const dir = join(ROOT, 'secrets', 'jwt', env === 'development' ? 'dev' : env);
const previous = join(dir, 'previous');

const fingerprint = (pem) => {
  const der = createPublicKey(pem).export({ type: 'spki', format: 'der' });
  return `sha256:${createHash('sha256').update(der).digest('hex').slice(0, 32)}`;
};

const describe = (where) => {
  const kid = readFileSync(join(where, 'kid'), 'utf8').trim();
  return `kid=${kid} ${fingerprint(readFileSync(join(where, 'public.pem'), 'utf8'))}`;
};

function writeKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const kid = `${env}-${new Date().toISOString().slice(0, 10)}-${randomBytes(3).toString('hex')}`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'private.pem'), privateKey, { mode: 0o600 });
  writeFileSync(join(dir, 'public.pem'), publicKey, { mode: 0o644 });
  writeFileSync(join(dir, 'kid'), `${kid}\n`, { mode: 0o644 });
}

switch (command) {
  case 'generate':
    if (existsSync(join(dir, 'private.pem'))) {
      console.error(`${dir} already holds a key — use rotate, which keeps the old one verifiable.`);
      process.exit(1);
    }
    writeKey();
    writeFileSync(join(dir, 'pepper'), `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 });
    console.log(`${env}: ${describe(dir)}`);
    break;

  case 'rotate':
    if (!existsSync(join(dir, 'private.pem'))) {
      console.error(`${dir} holds no key yet — use generate.`);
      process.exit(1);
    }
    rmSync(previous, { recursive: true, force: true });
    mkdirSync(previous, { recursive: true, mode: 0o700 });
    cpSync(join(dir, 'public.pem'), join(previous, 'public.pem'));
    cpSync(join(dir, 'kid'), join(previous, 'kid'));
    writeKey();
    console.log(`${env}: signing   ${describe(dir)}`);
    console.log(`${env}: verifying ${describe(previous)} until its last token expires — then run retire`);
    break;

  case 'retire':
    rmSync(previous, { recursive: true, force: true });
    console.log(`${env}: ${describe(dir)} (no previous key)`);
    break;

  case 'fingerprint':
    console.log(`${env}: ${describe(dir)}`);
    if (existsSync(previous)) console.log(`${env}: previous ${describe(previous)}`);
    break;
}
