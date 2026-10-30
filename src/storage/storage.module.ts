import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Env } from '../config/env.schema';
import { connectStorage, Storage } from './s3';

export const STORAGE = Symbol('STORAGE');

export function createStorage(config: ConfigService<Env, true>): Storage {
  return connectStorage({
    endpoint: config.get('STORAGE_ENDPOINT', { infer: true }),
    region: config.get('STORAGE_REGION', { infer: true }),
    bucket: config.get('STORAGE_BUCKET', { infer: true }),
    accessKeyId: config.get('STORAGE_ACCESS_KEY', { infer: true }),
    secretAccessKey: config.get('STORAGE_SECRET_KEY', { infer: true }),
  });
}

@Global()
@Module({
  providers: [{ provide: STORAGE, inject: [ConfigService], useFactory: createStorage }],
  exports: [STORAGE],
})
export class StorageModule {}
