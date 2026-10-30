// Every number of the upload path, and where it comes from.

export const KiB = 1024;
export const MiB = 1024 * KiB;
export const GiB = 1024 * MiB;

// S3's own limits — the same on AWS, R2 and RustFS.
export const MIN_PART_SIZE = 5 * MiB; // every part except the last
export const MAX_PARTS = 10_000;
export const MAX_SINGLE_PUT = 5 * GiB;

// Multipart pays one request per part plus Create and Complete. It earns that
// back when a broken connection would otherwise cost a lot: below two full
// minimum parts there is at most one part to keep after a failure, so the file
// goes up in one PUT. Above it, a failure costs at most one part.
export const MULTIPART_THRESHOLD = 2 * MIN_PART_SIZE;

// What this API accepts. Products photos, avatars, documents and short clips;
// 5 GiB keeps every file a single object the edge could still serve.
export const MAX_UPLOAD_SIZE = 5 * GiB;

// A presigned PUT for a form upload: the browser starts the PUT right after the
// intent answers, and S3 checks the expiry when the request starts, not when the
// last byte arrives. Five minutes covers a slow phone and a retry; anything
// longer is a URL that keeps working after it has leaked into a log. It is the
// default of UPLOAD_PUT_TTL_SECONDS in the config schema.
export const PUT_URL_TTL_SECONDS = 300;

// A part URL: fifteen minutes, because the parts of a big file go one after
// another and a URL may wait its turn. A resumed upload asks for fresh ones.
export const PART_URL_TTL_SECONDS = 900;

// GET /files/:id answers 302 to a URL that lives one minute: long enough to
// follow the redirect, too short to be worth stealing.
export const DOWNLOAD_URL_TTL_SECONDS = 60;

// The extension comes from this table, keyed by the declared type — never from
// the client's filename.
export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'video/mp4': 'mp4',
};

export type UploadPlan =
  | { mode: 'single' }
  | { mode: 'multipart'; partSize: number; partCount: number };

// partSize ≥ size / 10 000, rounded up to a whole MiB, and never below 5 MiB: a
// fixed 5 MiB would fail on anything above ~48.8 GiB. At the 5 GiB cap that is
// still 5 MiB (1 024 parts); at S3's 5 TiB object limit it would be 525 MiB.
export function planUpload(size: number): UploadPlan {
  if (size <= MULTIPART_THRESHOLD) return { mode: 'single' };

  const partSize = Math.max(MIN_PART_SIZE, Math.ceil(size / MAX_PARTS / MiB) * MiB);
  return { mode: 'multipart', partSize, partCount: Math.ceil(size / partSize) };
}
