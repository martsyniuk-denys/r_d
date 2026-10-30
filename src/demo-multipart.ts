import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HeadObjectCommand, ListPartsCommand } from '@aws-sdk/client-s3';

import { Api, Invariants, login, openDatabase, report, resetAccount, runDemo } from './auth/demo-kit';
import { minimalEnv, resetUserFiles, runChild } from './files/demo-kit';
import { MiB } from './files/upload-plan';
import { connectStorage, ensureBucket, statusOf, storageSettingsFromEnv } from './storage/s3';

// Multipart is about resuming, not about size.
//
//   12 MiB → the API plans 3 parts of 5 MiB (5 + 5 + 2)
//   uploader #1 sends parts 1 and 2 and is SIGKILLed — the "dropped connection"
//   storage now holds 2 parts, and no object: HeadObject → 404
//   uploader #2, a new process, asks which parts exist (ListParts) and sends only part 3
//   commit → CompleteMultipartUpload → the object, 12 MiB, ETag "…-3" (not the file's MD5)
//
// The state is reset at the start (unfinished uploads aborted, the object and the
// row deleted) and again at the end, so the second run sees exactly what the first did.

const SIZE = 12 * MiB;

function content(size: number): Buffer {
  const body = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) body[i] = (i * 2654435761) >>> 24;
  return body;
}

interface MultipartIntent {
  file_id: string;
  key: string;
  mode: string;
  part_size: number;
  part_count: number;
}

runDemo(async () => {
  const invariants = new Invariants();
  const dataSource = await openDatabase();
  const storage = connectStorage(storageSettingsFromEnv());
  const dir = mkdtempSync(join(tmpdir(), 'demo-multipart-'));
  let api: Api | undefined;
  let ownerId: string | undefined;

  try {
    await ensureBucket(storage);
    const buyer = await resetAccount(dataSource, 'demo-multipart', 'buyer', 'buyer');
    ownerId = buyer.id;
    const cleared = await resetUserFiles(dataSource, storage, buyer.id);
    console.log(`clean slate: ${cleared.aborted} unfinished upload(s) aborted, ${cleared.deleted} object(s) deleted`);

    const file = join(dir, 'clip.mp4');
    const body = content(SIZE);
    writeFileSync(file, body);

    api = await Api.start();
    const token = (await login(api, buyer)).body.access_token;
    const intent = await api.call<MultipartIntent>('POST', '/uploads/intent', {
      token,
      headers: { 'Idempotency-Key': `demo-multipart-${randomUUID()}` },
      body: { filename: 'clip.mp4', content_type: 'video/mp4', size: SIZE },
    });
    const { file_id: fileId, key } = intent.body;
    console.log(`intent: ${SIZE} bytes → ${intent.body.mode}, ${intent.body.part_count} parts of ${intent.body.part_size}`);

    const [{ upload_id: uploadId }]: { upload_id: string }[] = await dataSource.query(
      `SELECT upload_id FROM files WHERE id = $1`,
      [fileId],
    );
    const uploaderArgs = ['--api', api.url, '--file-id', fileId, '--file', file];
    const childEnv = minimalEnv({ UPLOAD_TOKEN: token });

    const crashed = await runChild('files/part-uploader.js', [...uploaderArgs, '--crash-after', '2'], childEnv);
    const sentBeforeCrash = crashed.events.filter((event) => event.kind === 'part').length;
    console.log(`uploader #1: sent ${sentBeforeCrash} part(s), ended by ${crashed.signal ?? `exit ${crashed.code}`}`);

    const listed = await storage.s3.send(new ListPartsCommand({ Bucket: storage.bucket, Key: key, UploadId: uploadId }));
    const partsInStorage = (listed.Parts ?? []).length;
    let headBeforeComplete = 200;
    try {
      await storage.s3.send(new HeadObjectCommand({ Bucket: storage.bucket, Key: key }));
    } catch (error) {
      headBeforeComplete = statusOf(error) ?? 0;
    }
    console.log(`storage: ${partsInStorage} part(s) of the upload, HeadObject on the key → ${headBeforeComplete}`);

    const resumed = await runChild('files/part-uploader.js', uploaderArgs, childEnv);
    const plan = resumed.events.find((event) => event.kind === 'plan') as { already: number[]; missing: number[] } | undefined;
    const resumedParts = Number(resumed.events.find((event) => event.kind === 'done')?.uploaded ?? -1);
    console.log(`uploader #2: storage already had parts [${plan?.already}], sent [${plan?.missing}]`);

    const commit = await api.call('POST', '/uploads/commit', { token, body: { file_id: fileId } });
    const head = await storage.s3.send(new HeadObjectCommand({ Bucket: storage.bucket, Key: key }));
    const etag = (head.ETag ?? '').replace(/"/g, '');
    const md5 = createHash('md5').update(body).digest('hex');
    const sizeMatch = head.ContentLength === SIZE ? 1 : 0;
    const etagMultipart = new RegExp(`-${intent.body.part_count}$`).test(etag) ? 1 : 0;
    console.log(`complete: ${head.ContentLength} bytes, ETag ${etag}, MD5 of the file ${md5}\n`);

    invariants.check('the plan is multipart, 3 parts', intent.body.mode === 'multipart' && intent.body.part_count === 3, `${intent.body.mode}/${intent.body.part_count}`);
    invariants.check('the first uploader died after 2 parts', crashed.signal === 'SIGKILL' && sentBeforeCrash === 2, `${sentBeforeCrash}, ${crashed.signal}`);
    invariants.check('parts in storage, no object yet', partsInStorage === 2 && headBeforeComplete === 404, `${partsInStorage} parts, HEAD ${headBeforeComplete}`);
    invariants.check('the second uploader sent only what was missing', resumedParts === 1, `${resumedParts}`);
    invariants.check('complete', commit.status === 200, `${commit.status}`);
    invariants.check('size matches', sizeMatch === 1, `${head.ContentLength} / ${SIZE}`);
    invariants.check('the ETag is a multipart ETag, not the MD5', etagMultipart === 1 && etag !== md5, etag);
    console.log('');

    report({
      'parts-planned': intent.body.part_count,
      'parts-before-crash': sentBeforeCrash,
      'head-before-complete': headBeforeComplete,
      'resumed-parts': resumedParts,
      complete: commit.status,
      'size-match': sizeMatch,
      'etag-multipart': etagMultipart,
      'etag-is-md5': etag === md5 ? 1 : 0,
    });

    if (invariants.broken > 0) console.error(api.log.join('\n'));
    return invariants.broken === 0 ? 0 : 1;
  } finally {
    await api?.stop();
    if (ownerId !== undefined) await resetUserFiles(dataSource, storage, ownerId);
    rmSync(dir, { recursive: true, force: true });
    await dataSource.destroy();
    storage.s3.destroy();
  }
});
