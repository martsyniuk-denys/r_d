import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';

// One S3 client for the app, the edge and the demos. Nothing else knows which
// vendor sits behind the endpoint: RustFS in compose, AWS S3 when STORAGE_ENDPOINT
// is empty — the API is the same, only the address changes.

export interface StorageSettings {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface Storage {
  s3: S3Client;
  bucket: string;
  endpoint?: string;
}

const HINT =
  'Storage credentials come from the environment only. Either go through the secret store ' +
  '(bash scripts/with-secrets.sh dev <command> — every npm script that talks to the bucket already ' +
  'does), or export STORAGE_ENDPOINT STORAGE_BUCKET STORAGE_ACCESS_KEY STORAGE_SECRET_KEY yourself and set SKIP_VAULT=1.';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set. ${HINT}`);
  return value;
}

// For the processes outside Nest (demos, the edge): the same variables the
// config schema validates for the app.
export function storageSettingsFromEnv(): StorageSettings {
  const endpoint = process.env.STORAGE_ENDPOINT;
  return {
    endpoint: endpoint === undefined || endpoint === '' ? undefined : endpoint,
    region: process.env.STORAGE_REGION || 'us-east-1',
    bucket: required('STORAGE_BUCKET'),
    accessKeyId: required('STORAGE_ACCESS_KEY'),
    secretAccessKey: required('STORAGE_SECRET_KEY'),
  };
}

export function connectStorage(settings: StorageSettings): Storage {
  const s3 = new S3Client({
    region: settings.region,
    endpoint: settings.endpoint,
    // Emulators serve buckets under the path, AWS under a subdomain.
    forcePathStyle: settings.endpoint !== undefined,
    credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
    // The SDK checksums uploads by default since late 2024. A presigned URL is
    // signed before there is a body, so it would carry the CRC32 of nothing in its
    // query; checksums only where the operation requires them.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return { s3, bucket: settings.bucket, endpoint: settings.endpoint };
}

// The bucket is part of the state the code expects, so the code makes sure of it:
// created when missing (private — nothing here ever grants anonymous access), and
// with the one lifecycle rule every bucket that takes multipart uploads needs.
// An abandoned multipart upload is billed while no object exists and nothing shows
// it in a listing; "delete objects older than N days" does not touch it.
export async function ensureBucket(storage: Storage): Promise<void> {
  try {
    await storage.s3.send(new HeadBucketCommand({ Bucket: storage.bucket }));
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status !== 404) throw error;
    await storage.s3.send(new CreateBucketCommand({ Bucket: storage.bucket }));
  }

  await storage.s3.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: storage.bucket,
      LifecycleConfiguration: {
        Rules: [
          {
            ID: 'abort-incomplete-multipart-uploads',
            Status: 'Enabled',
            Filter: { Prefix: '' },
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
          },
        ],
      },
    }),
  );
}

export function statusOf(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
}
