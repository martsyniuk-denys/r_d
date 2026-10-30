import { randomUUID } from 'node:crypto';

import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  Part,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';

import { Principal } from '../auth/principal';
import { ProblemError, TYPE_BASE, badRequest, notFound } from '../common/problem';
import { Env } from '../config/env.schema';
import { PG_POOL } from '../db/database.module';
import { FileStatus } from '../entities/stored-file.entity';
import { STORAGE } from '../storage/storage.module';
import { Storage, ensureBucket, statusOf } from '../storage/s3';
import {
  CONTENT_TYPES,
  DOWNLOAD_URL_TTL_SECONDS,
  MAX_UPLOAD_SIZE,
  PART_URL_TTL_SECONDS,
  planUpload,
} from './upload-plan';

export interface IntentInput {
  filename: string;
  content_type: string;
  size: number;
}

export interface PartUrl {
  part_number: number;
  url: string;
}

export type Intent =
  | {
      file_id: string;
      key: string;
      mode: 'single';
      url: string;
      method: 'PUT';
      headers: Record<string, string>;
      expires_in: number;
    }
  | {
      file_id: string;
      key: string;
      mode: 'multipart';
      part_size: number;
      part_count: number;
      parts: PartUrl[];
      expires_in: number;
    };

export interface PartsStatus {
  file_id: string;
  part_size: number;
  part_count: number;
  uploaded: { part_number: number; size: number }[];
  missing: PartUrl[];
  expires_in: number;
}

export interface FileView {
  file_id: string;
  key: string;
  status: FileStatus;
  content_type: string;
  size: number;
  etag: string | null;
}

interface FileRow {
  id: string;
  key: string;
  owner_id: string;
  status: FileStatus;
  content_type: string;
  size: string;
  upload_id: string | null;
  part_size: number | null;
  part_count: number | null;
}

const conflict = (detail: string): ProblemError =>
  new ProblemError({ status: 409, title: 'Conflict', detail, type: `${TYPE_BASE}/upload-incomplete` });

// The two-step upload. The API decides *what* may be written *where* and signs
// exactly that; the bytes go from the client straight to the bucket; the commit
// believes nothing the client says and asks the bucket what is actually there.
@Injectable()
export class FilesService implements OnModuleInit {
  private readonly logger = new Logger('files');
  private readonly putTtl: number;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(STORAGE) private readonly storage: Storage,
    config: ConfigService<Env, true>,
  ) {
    this.putTtl = config.get('UPLOAD_PUT_TTL_SECONDS', { infer: true });
  }

  // A bucket that is not there yet is created; storage that is down is a warning,
  // not a refusal to start — the rest of the API does not need it.
  async onModuleInit(): Promise<void> {
    try {
      await ensureBucket(this.storage);
    } catch (error) {
      this.logger.warn(`bucket ${this.storage.bucket} not ready: ${error instanceof Error ? error.message : error}`);
    }
  }

  async intent(principal: Principal, input: IntentInput): Promise<Intent> {
    const ext = CONTENT_TYPES[input.content_type];
    if (ext === undefined) {
      throw badRequest(`content_type '${input.content_type}' is not accepted; one of: ${Object.keys(CONTENT_TYPES).join(', ')}.`);
    }
    if (!Number.isSafeInteger(input.size) || input.size < 1 || input.size > MAX_UPLOAD_SIZE) {
      throw badRequest(`size must be between 1 and ${MAX_UPLOAD_SIZE} bytes.`);
    }

    // The key is the server's: the caller's id, a fresh UUID and an extension from
    // the allowlist. The filename is not used at all — "../../etc/passwd" or
    // "uploads/42/avatar.png" in it would otherwise be a write anywhere in the bucket.
    const id = randomUUID();
    const key = `uploads/${principal.userId}/${id}.${ext}`;
    const plan = planUpload(input.size);
    const { s3, bucket } = this.storage;

    if (plan.mode === 'single') {
      await this.pool.query(
        `INSERT INTO files (id, key, owner_id, status, content_type, size) VALUES ($1, $2, $3, 'PENDING', $4, $5)`,
        [id, key, principal.userId, input.content_type, input.size],
      );
      // Content-Type and Content-Length are signed: the PUT must send exactly
      // these, so the URL cannot carry a different type or a bigger file.
      const url = await getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: input.content_type, ContentLength: input.size }),
        { expiresIn: this.putTtl },
      );
      this.logger.log(`intent file=${id} key=${key} single size=${input.size}`);
      return {
        file_id: id,
        key,
        mode: 'single',
        url,
        method: 'PUT',
        headers: { 'Content-Type': input.content_type },
        expires_in: this.putTtl,
      };
    }

    const created = await s3.send(
      new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: input.content_type }),
    );
    await this.pool.query(
      `INSERT INTO files (id, key, owner_id, status, content_type, size, upload_id, part_size, part_count)
       VALUES ($1, $2, $3, 'PENDING', $4, $5, $6, $7, $8)`,
      [id, key, principal.userId, input.content_type, input.size, created.UploadId, plan.partSize, plan.partCount],
    );
    const numbers = Array.from({ length: plan.partCount }, (_, i) => i + 1);
    this.logger.log(`intent file=${id} key=${key} multipart parts=${plan.partCount} part-size=${plan.partSize}`);
    return {
      file_id: id,
      key,
      mode: 'multipart',
      part_size: plan.partSize,
      part_count: plan.partCount,
      parts: await this.signParts(key, created.UploadId!, numbers),
      expires_in: PART_URL_TTL_SECONDS,
    };
  }

  // The resume: what the bucket already holds for this upload (ListParts — the
  // bucket's word, not a client-side journal that died with the process), and
  // fresh URLs for the parts that are missing.
  async parts(principal: Principal, fileId: string): Promise<PartsStatus> {
    const file = await this.owned(principal, fileId);
    if (file.upload_id === null || file.part_count === null || file.part_size === null) {
      throw conflict(`File '${fileId}' is a single-PUT upload; it has no parts.`);
    }
    if (file.status === 'COMPLETED') throw conflict(`File '${fileId}' is already complete.`);

    const uploaded = await this.listParts(file.key, file.upload_id);
    const have = new Set(uploaded.map((part) => part.PartNumber));
    const missing = Array.from({ length: file.part_count }, (_, i) => i + 1).filter((n) => !have.has(n));

    return {
      file_id: file.id,
      part_size: file.part_size,
      part_count: file.part_count,
      uploaded: uploaded.map((part) => ({ part_number: part.PartNumber!, size: part.Size! })),
      missing: await this.signParts(file.key, file.upload_id, missing),
      expires_in: PART_URL_TTL_SECONDS,
    };
  }

  // COMPLETED only after the bucket says the object exists, with the declared
  // size. Without the HeadObject a client could commit a file it never uploaded,
  // and the database would point at nothing.
  async commit(principal: Principal, fileId: string): Promise<FileView> {
    const file = await this.owned(principal, fileId);
    const { s3, bucket } = this.storage;

    if (file.status === 'COMPLETED') return this.view(file, await this.etagOf(file.key));

    if (file.upload_id !== null) {
      const parts = await this.listParts(file.key, file.upload_id);
      if (parts.length !== file.part_count) {
        throw conflict(`File '${fileId}' has ${parts.length} of ${file.part_count} parts in storage.`);
      }
      try {
        await s3.send(
          new CompleteMultipartUploadCommand({
            Bucket: bucket,
            Key: file.key,
            UploadId: file.upload_id,
            MultipartUpload: { Parts: parts.map((part) => ({ PartNumber: part.PartNumber, ETag: part.ETag })) },
          }),
        );
      } catch (error) {
        throw conflict(`Storage refused to complete '${fileId}': ${error instanceof Error ? error.message : error}`);
      }
    }

    let size: number;
    let etag: string | null;
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: file.key }));
      size = head.ContentLength ?? -1;
      etag = head.ETag ?? null;
    } catch (error) {
      if (statusOf(error) === 404) throw conflict(`Nothing was uploaded for file '${fileId}' yet.`);
      throw error;
    }
    if (size !== Number(file.size)) {
      throw conflict(`File '${fileId}' is ${size} bytes in storage, ${file.size} were declared.`);
    }

    await this.pool.query(`UPDATE files SET status = 'COMPLETED', completed_at = now() WHERE id = $1`, [file.id]);
    this.logger.log(`commit file=${file.id} key=${file.key} size=${size}`);
    return this.view({ ...file, status: 'COMPLETED' }, etag);
  }

  // The API stays on the authorization path of a download and off its data path:
  // the guard and the owner check run on every request, the bytes come from the
  // bucket through a URL that lives a minute. A presigned URL cannot be revoked,
  // so it is never handed out for longer than it is needed.
  async downloadUrl(principal: Principal, fileId: string): Promise<string> {
    const file = await this.owned(principal, fileId);
    if (file.status !== 'COMPLETED') throw conflict(`File '${fileId}' has not been committed.`);
    return getSignedUrl(this.storage.s3, new GetObjectCommand({ Bucket: this.storage.bucket, Key: file.key }), {
      expiresIn: DOWNLOAD_URL_TTL_SECONDS,
    });
  }

  // Ownership is part of the query: somebody else's file is simply not found.
  private async owned(principal: Principal, fileId: string): Promise<FileRow> {
    if (!/^[0-9a-f-]{36}$/i.test(fileId)) throw notFound(`File '${fileId}' does not exist.`);
    const { rows } = await this.pool.query<FileRow>(
      `SELECT id, key, owner_id, status, content_type, size, upload_id, part_size, part_count
         FROM files WHERE id = $1 AND (owner_id = $2 OR $3)`,
      [fileId, principal.userId, principal.role === 'admin'],
    );
    if (rows.length === 0) throw notFound(`File '${fileId}' does not exist.`);
    return rows[0];
  }

  private async listParts(key: string, uploadId: string): Promise<Part[]> {
    const parts: Part[] = [];
    let marker: string | undefined;
    do {
      const page = await this.storage.s3.send(
        new ListPartsCommand({ Bucket: this.storage.bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }),
      );
      parts.push(...(page.Parts ?? []));
      marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
    } while (marker !== undefined);
    return parts;
  }

  private signParts(key: string, uploadId: string, numbers: number[]): Promise<PartUrl[]> {
    return Promise.all(
      numbers.map(async (partNumber) => ({
        part_number: partNumber,
        url: await getSignedUrl(
          this.storage.s3,
          new UploadPartCommand({ Bucket: this.storage.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
          { expiresIn: PART_URL_TTL_SECONDS },
        ),
      })),
    );
  }

  private async etagOf(key: string): Promise<string | null> {
    const head = await this.storage.s3.send(new HeadObjectCommand({ Bucket: this.storage.bucket, Key: key }));
    return head.ETag ?? null;
  }

  private view(file: FileRow, etag: string | null): FileView {
    return {
      file_id: file.id,
      key: file.key,
      status: file.status,
      content_type: file.content_type,
      size: Number(file.size),
      etag,
    };
  }
}
