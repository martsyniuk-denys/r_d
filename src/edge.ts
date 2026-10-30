import 'reflect-metadata';

import { createServer } from 'node:http';
import { parseArgs } from 'node:util';

import { GetObjectCommand } from '@aws-sdk/client-s3';

import { connectStorage, statusOf, storageSettingsFromEnv } from './storage/s3';

// The edge: the only reader of the bucket the public ever talks to. It fetches an
// object with its own credentials (the bucket stays private — an anonymous GET is
// 403), keeps it for as long as the object's Cache-Control allows, and says which
// it was in X-Cache. This is what CloudFront + OAC does: the cache goes to the
// bucket, the public goes to the cache.
//
//   node dist/edge.js [--port 0]       prints {"kind":"ready","pid":…,"url":"http://…"}

const { values } = parseArgs({ options: { port: { type: 'string', default: '0' } } });
const storage = connectStorage(storageSettingsFromEnv());

interface Entry {
  body: Buffer;
  type: string;
  cacheControl: string;
  until: number;
}
const cache = new Map<string, Entry>();

// Only what the origin marked public with a max-age is kept: private, no-store or
// no Cache-Control at all means every request goes to the bucket.
function ttlSeconds(cacheControl: string): number {
  if (!/\bpublic\b/.test(cacheControl) || /\b(no-store|private|no-cache)\b/.test(cacheControl)) return 0;
  return Number(/\bmax-age=(\d+)/.exec(cacheControl)?.[1] ?? 0);
}

const server = createServer(async (req, res) => {
  const key = decodeURIComponent((req.url ?? '/').split('?')[0].slice(1));
  // Only published assets are public. Uploads are private and go through
  // GET /files/:id, which checks the owner.
  if (req.method !== 'GET' || !/^assets\/[\w.-]+$/.test(key)) {
    res.writeHead(404).end();
    return;
  }

  let entry = cache.get(key);
  const hit = entry !== undefined && entry.until > Date.now();
  if (!hit) {
    try {
      const object = await storage.s3.send(new GetObjectCommand({ Bucket: storage.bucket, Key: key }));
      const cacheControl = object.CacheControl ?? '';
      entry = {
        body: Buffer.from(await object.Body!.transformToByteArray()),
        type: object.ContentType ?? 'application/octet-stream',
        cacheControl,
        until: Date.now() + ttlSeconds(cacheControl) * 1000,
      };
      if (ttlSeconds(cacheControl) > 0) cache.set(key, entry);
    } catch (error) {
      res.writeHead(statusOf(error) === 404 ? 404 : 502).end();
      return;
    }
  }

  res.writeHead(200, {
    'Content-Type': entry!.type,
    'Cache-Control': entry!.cacheControl,
    'Content-Length': entry!.body.length,
    'X-Cache': hit ? 'HIT' : 'MISS',
  });
  res.end(entry!.body);
});

server.listen(Number(values.port), '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  console.log(JSON.stringify({ kind: 'ready', pid: process.pid, url: `http://127.0.0.1:${port}` }));
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
