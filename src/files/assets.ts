import { createHash } from 'node:crypto';

import { PutObjectCommand } from '@aws-sdk/client-s3';

import { Storage } from '../storage/s3';

// Public assets are published under a name that contains a hash of their content:
// app.css → assets/app.15c42ab7.css. A new version is a new name, so a cache never
// has to be told to forget the old one — the old entry is simply never asked for
// again, and nobody pays for an invalidation.
//
// The Cache-Control is set here, on the object, when it is uploaded: the edge and
// any CDN cache what the origin tells them to. Without it nothing gets cached.
export const IMMUTABLE = 'public, max-age=31536000, immutable';

export function hashedKey(name: string, body: Buffer): string {
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 8);
  const dot = name.lastIndexOf('.');
  const [base, ext] = dot === -1 ? [name, ''] : [name.slice(0, dot), name.slice(dot)];
  return `assets/${base}.${hash}${ext}`;
}

export async function publishAsset(
  storage: Storage,
  name: string,
  body: Buffer,
  contentType: string,
): Promise<string> {
  const key = hashedKey(name, body);
  await storage.s3.send(
    new PutObjectCommand({
      Bucket: storage.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: IMMUTABLE,
    }),
  );
  return key;
}
