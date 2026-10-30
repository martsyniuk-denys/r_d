import { openSync, readSync, closeSync } from 'node:fs';
import { parseArgs } from 'node:util';

// The resumable side of a multipart upload, as its own process. It asks the API
// which parts storage already holds (the API asks ListParts) and uploads only the
// missing ones, each straight to the bucket through its presigned URL. Started
// twice by demo:multipart: the first time with --crash-after 2, so it dies with
// SIGKILL right after its second part; the second time to finish the job.
//
// The environment is PATH and UPLOAD_TOKEN (the caller's access token) — no
// storage credentials. A token in argv would be visible in `ps`.
//
//   node dist/files/part-uploader.js --api URL --file-id ID --file PATH [--crash-after N]

const { values } = parseArgs({
  options: {
    api: { type: 'string' },
    'file-id': { type: 'string' },
    file: { type: 'string' },
    'crash-after': { type: 'string' },
  },
});

interface PartsStatus {
  part_size: number;
  part_count: number;
  uploaded: { part_number: number }[];
  missing: { part_number: number; url: string }[];
}

const emit = (event: Record<string, unknown>): void => console.log(JSON.stringify(event));

async function main(): Promise<void> {
  const response = await fetch(`${values.api}/uploads/${values['file-id']}/parts`, {
    headers: { Authorization: `Bearer ${process.env.UPLOAD_TOKEN}` },
  });
  if (response.status !== 200) throw new Error(`GET parts → ${response.status}`);
  const status = (await response.json()) as PartsStatus;
  emit({ kind: 'plan', already: status.uploaded.map((p) => p.part_number), missing: status.missing.map((p) => p.part_number) });

  const crashAfter = values['crash-after'] === undefined ? Infinity : Number(values['crash-after']);
  const fd = openSync(values.file!, 'r');
  let uploaded = 0;
  try {
    for (const part of status.missing) {
      const body = Buffer.alloc(status.part_size);
      const read = readSync(fd, body, 0, status.part_size, (part.part_number - 1) * status.part_size);
      const put = await fetch(part.url, { method: 'PUT', body: body.subarray(0, read) });
      if (put.status !== 200) throw new Error(`PUT part ${part.part_number} → ${put.status}`);
      uploaded += 1;
      emit({ kind: 'part', part_number: part.part_number, bytes: read });

      // The connection "drops": no cleanup, no message, nothing kept in memory survives.
      if (uploaded >= crashAfter) process.kill(process.pid, 'SIGKILL');
    }
  } finally {
    closeSync(fd);
  }
  emit({ kind: 'done', uploaded });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
