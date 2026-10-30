import 'reflect-metadata';
import { ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { Invariants, report, runDemo } from './common/demo-output';
import { publishAsset } from './files/assets';
import { clearPrefix } from './files/demo-kit';
import { connectStorage, ensureBucket, storageSettingsFromEnv } from './storage/s3';

// The bucket is closed, the edge is open, and an update needs no invalidation.
//
//   publish demo-app.css v1 → assets/demo-app.<hash1>.css, Cache-Control immutable
//   anonymous GET straight to the bucket → 403
//   through the edge → MISS, then HIT
//   "deploy" v2 → assets/demo-app.<hash2>.css: a new name, a new URL, the new body
//   the old URL is still a HIT with the old body — nobody had to purge anything

const V1 = Buffer.from('/* demo-app v1 */\nbody { color: #1f2937; }\n');
const V2 = Buffer.from('/* demo-app v2 */\nbody { color: #b91c1c; }\n');

function startEdge(): Promise<{ child: ChildProcess; url: string }> {
  const child = spawn(process.execPath, [join(__dirname, 'edge.js')], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
  process.on('exit', () => child.kill('SIGKILL'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the edge did not start within 10 s')), 10_000);
    child.once('exit', (code) => reject(new Error(`the edge exited with ${code}`)));
    createInterface({ input: child.stdout! }).on('line', (line) => {
      if (!line.startsWith('{')) return;
      const event = JSON.parse(line) as { kind: string; url: string };
      if (event.kind !== 'ready') return;
      clearTimeout(timer);
      resolve({ child, url: event.url });
    });
  });
}

runDemo(async () => {
  const invariants = new Invariants();
  const settings = storageSettingsFromEnv();
  const storage = connectStorage(settings);
  let edge: ChildProcess | undefined;

  try {
    await ensureBucket(storage);
    const cleared = await clearPrefix(storage, 'assets/demo-app.');
    console.log(`clean slate: ${cleared.deleted} demo asset(s) of the last run removed`);

    const key1 = await publishAsset(storage, 'demo-app.css', V1, 'text/css');

    const origin = settings.endpoint ?? `https://s3.${settings.region}.amazonaws.com`;
    const direct = (await fetch(`${origin}/${settings.bucket}/${key1}`)).status;
    console.log(`v1 → ${key1}; anonymous GET to the bucket → ${direct}`);

    const started = await startEdge();
    edge = started.child;
    const get = async (key: string) => {
      const response = await fetch(`${started.url}/${key}`);
      return {
        status: response.status,
        cache: response.headers.get('x-cache'),
        cacheControl: response.headers.get('cache-control'),
        body: Buffer.from(await response.arrayBuffer()),
      };
    };

    const miss = await get(key1);
    const hit = await get(key1);
    console.log(`edge: ${key1} → ${miss.status} ${miss.cache}, then ${hit.status} ${hit.cache} (Cache-Control: ${hit.cacheControl})`);

    const key2 = await publishAsset(storage, 'demo-app.css', V2, 'text/css');
    const fresh = await get(key2);
    const old = await get(key1);
    console.log(`deploy v2 → ${key2}; edge → ${fresh.status} ${fresh.cache}; the old URL → ${old.status} ${old.cache}\n`);

    const cacheHit = miss.cache === 'MISS' && hit.cache === 'HIT' ? 1 : 0;
    const newName = key2 !== key1 ? 1 : 0;
    const contentChanged = fresh.body.equals(V2) && !fresh.body.equals(miss.body) ? 1 : 0;

    invariants.check('the bucket refuses anonymous reads', direct === 403, `${direct}`);
    invariants.check('the edge serves it: MISS, then HIT', miss.status === 200 && hit.status === 200 && cacheHit === 1, `${miss.cache} → ${hit.cache}`);
    invariants.check('the origin set the caching policy', hit.cacheControl === 'public, max-age=31536000, immutable', `${hit.cacheControl}`);
    invariants.check('a new version is a new name', newName === 1, `${key1} → ${key2}`);
    invariants.check('the new URL serves the new body', fresh.status === 200 && contentChanged === 1, `${fresh.status}`);
    invariants.check('the old entry is untouched, no invalidation', old.cache === 'HIT' && old.body.equals(V1), `${old.cache}`);
    console.log('');

    report({
      direct,
      'edge-miss': miss.status,
      'edge-hit': hit.status,
      'cache-hit': cacheHit,
      'new-name': newName,
      'new-url': fresh.status,
      'content-changed': contentChanged,
      'old-url-hit': old.cache === 'HIT' ? 1 : 0,
    });

    return invariants.broken === 0 ? 0 : 1;
  } finally {
    if (edge !== undefined && edge.exitCode === null) {
      await new Promise<void>((resolve) => {
        edge!.once('exit', () => resolve());
        edge!.kill('SIGTERM');
      });
    }
    storage.s3.destroy();
  }
});
