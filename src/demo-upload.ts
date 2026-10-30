import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Api, Invariants, login, openDatabase, report, resetAccount, runDemo } from './auth/demo-kit';
import { minimalEnv, portAlive, resetUserFiles, runChild } from './files/demo-kit';
import { connectStorage, ensureBucket, storageSettingsFromEnv } from './storage/s3';

// The bytes do not pass through this service.
//
//   intent   filename "../../etc/passwd" → the key is uploads/<user>/<uuid>.png all the same
//   commit   of a second intent, with nothing uploaded → 409 (HeadObject found nothing)
//   tamper   the presigned URL with another key in its path → 403: the signature covers the path
//   stop the API, check its port is dead
//   PUT      the bytes, from a separate process whose environment is PATH alone
//   start the API again, on another port → commit → 200, the row is COMPLETED
//   expired  an intent with a 2-second URL, used 5 seconds later → 403

const SIZE = 64 * 1024;
const EVIL_NAME = '../../etc/passwd';
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface SingleIntent {
  file_id: string;
  key: string;
  url: string;
}

function pngBytes(size: number): Buffer {
  const body = Buffer.alloc(size);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(body);
  for (let i = 8; i < size; i += 1) body[i] = (i * 31) & 0xff;
  return body;
}

runDemo(async () => {
  const invariants = new Invariants();
  const dataSource = await openDatabase();
  const storage = connectStorage(storageSettingsFromEnv());
  const dir = mkdtempSync(join(tmpdir(), 'demo-upload-'));
  const apis: Api[] = [];

  try {
    await ensureBucket(storage);
    const buyer = await resetAccount(dataSource, 'demo-upload', 'buyer', 'buyer');
    const cleared = await resetUserFiles(dataSource, storage, buyer.id);
    console.log(`clean slate: ${cleared.deleted} object(s) and ${cleared.aborted} upload(s) of the last run removed`);

    const file = join(dir, 'photo.png');
    writeFileSync(file, pngBytes(SIZE));

    const first = await Api.start();
    apis.push(first);
    const token = (await login(first, buyer)).body.access_token;
    const intentOf = (api: Api, filename: string) =>
      api.call<SingleIntent>('POST', '/uploads/intent', {
        token,
        headers: { 'Idempotency-Key': `demo-upload-${randomUUID()}` },
        body: { filename, content_type: 'image/png', size: SIZE },
      });

    const intent = await intentOf(first, EVIL_NAME);
    const { key, url, file_id: fileId } = intent.body;
    const keyShape = new RegExp(`^uploads/${buyer.id}/[0-9a-f-]{36}\\.png$`);
    const keyFromServer = keyShape.test(key) && !key.includes('passwd') && !key.includes('..') ? 1 : 0;
    console.log(`intent: filename ${JSON.stringify(EVIL_NAME)} → key ${key}`);

    const empty = await intentOf(first, 'never-uploaded.png');
    const commitWithoutBytes = await first.call('POST', '/uploads/commit', { token, body: { file_id: empty.body.file_id } });

    const forged = url.replace(key, `uploads/${buyer.id}/${randomUUID()}.png`);
    const tampered = (await fetch(forged, { method: 'PUT', body: pngBytes(SIZE), headers: { 'Content-Type': 'image/png' } })).status;

    await first.stop();
    const apiAlive = (await portAlive(first.port)) ? 1 : 0;
    console.log(`API on :${first.port} stopped (alive=${apiAlive}); PUT from a process with env = { PATH }`);

    const put = await runChild('files/put-file.js', [url, file, 'image/png'], minimalEnv());
    const putOffline = put.code === 0 ? Number(put.events[0]?.status ?? 0) : 0;

    const second = await Api.start({ avoid: [first.port], env: { UPLOAD_PUT_TTL_SECONDS: '2' } });
    apis.push(second);
    console.log(`API back on :${second.port} (a different port), presigned PUT TTL 2 s`);
    const commit = await second.call<{ status: string; size: number }>('POST', '/uploads/commit', { token, body: { file_id: fileId } });
    const [row]: { status: string }[] = await dataSource.query(`SELECT status FROM files WHERE id = $1`, [fileId]);

    const download = await fetch(`${second.url}/files/${fileId}`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'manual' });
    const fetched = await fetch(download.headers.get('location') ?? 'about:blank');
    const sameBytes = Buffer.from(await fetched.arrayBuffer()).equals(pngBytes(SIZE));

    const short = await intentOf(second, 'late.png');
    await pause(5000);
    const expired = (await fetch(short.body.url, { method: 'PUT', body: pngBytes(SIZE), headers: { 'Content-Type': 'image/png' } })).status;
    console.log(`the same URL 5 s after a 2 s expiry → ${expired}`);
    console.log(`GET /files/${fileId} → ${download.status} → presigned GET → ${fetched.status}, same bytes: ${sameBytes}\n`);

    invariants.check('intent', intent.status === 200, `${intent.status}`);
    invariants.check('the key is the server\'s, nothing of the filename in it', keyFromServer === 1, key);
    invariants.check('commit with nothing uploaded is 4xx', commitWithoutBytes.status >= 400 && commitWithoutBytes.status < 500, `${commitWithoutBytes.status}`);
    invariants.check('a URL with another key is refused', tampered === 403, `${tampered}`);
    invariants.check('the API was down during the PUT', apiAlive === 0, `alive=${apiAlive}`);
    invariants.check('the bytes reached storage without the API', putOffline === 200, `${putOffline}`);
    invariants.check('commit after the PUT', commit.status === 200 && row?.status === 'COMPLETED', `${commit.status}, row ${row?.status}`);
    invariants.check('an expired URL is refused', expired === 403, `${expired}`);
    invariants.check('download: 302 to storage, the same bytes', download.status === 302 && fetched.status === 200 && sameBytes, `${download.status} → ${fetched.status}`);
    console.log('');

    report({
      intent: intent.status,
      'key-from-server': keyFromServer,
      'api-alive': apiAlive,
      'put-offline': putOffline,
      commit: commit.status,
      'commit-without-bytes': commitWithoutBytes.status,
      tampered,
      expired,
      download: download.status,
    });

    if (invariants.broken > 0) for (const api of apis) console.error(api.log.join('\n'));
    return invariants.broken === 0 ? 0 : 1;
  } finally {
    for (const api of apis) await api.stop();
    rmSync(dir, { recursive: true, force: true });
    await dataSource.destroy();
    storage.s3.destroy();
  }
});
