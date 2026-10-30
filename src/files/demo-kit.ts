import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { join } from 'node:path';

import {
  AbortMultipartUploadCommand,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { DataSource } from 'typeorm';

import { Storage } from '../storage/s3';

// What the three file demos share on top of src/auth/demo-kit.ts: a clean slate
// in the bucket and in the files table, child processes with a chosen (empty)
// environment, and a liveness check that does not go through fetch.

// Everything under a prefix: unfinished multipart uploads first (they are billed,
// and invisible to ListObjects), then the objects. Listing is fine here — it is a
// cleanup of a demo's own prefix, not how the app finds a user's files.
export async function clearPrefix(storage: Storage, prefix: string): Promise<{ aborted: number; deleted: number }> {
  const { s3, bucket } = storage;
  let aborted = 0;
  let deleted = 0;

  const uploads = await s3.send(new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: prefix }));
  for (const upload of uploads.Uploads ?? []) {
    await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: upload.Key, UploadId: upload.UploadId }));
    aborted += 1;
  }

  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    const keys = (page.Contents ?? []).map((object) => ({ Key: object.Key! }));
    if (keys.length > 0) {
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } }));
      deleted += keys.length;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token !== undefined);

  return { aborted, deleted };
}

export async function resetUserFiles(
  dataSource: DataSource,
  storage: Storage,
  userId: string,
): Promise<{ aborted: number; deleted: number }> {
  await dataSource.query(`DELETE FROM files WHERE owner_id = $1`, [userId]);
  return clearPrefix(storage, `uploads/${userId}/`);
}

export interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  events: Record<string, unknown>[];
}

// A dist/ script in its own process, with exactly the environment given — not
// this process's. JSON lines on stdout come back as events.
export function runChild(script: string, args: string[], env: Record<string, string>): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(__dirname, '..', script), ...args], {
      env,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      const events = out
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      resolve({ code, signal, events });
    });
  });
}

// Is anything listening? A raw TCP connect, not fetch: fetch keeps a pool per
// (host, port) and would happily try a dead socket from it.
export function portAlive(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export const minimalEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  ...extra,
});
