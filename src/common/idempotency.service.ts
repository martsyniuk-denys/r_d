import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { idempotencyKeyReuse } from './problem';

interface Entry {
  fingerprint: string;
  status: number;
  body: unknown;
}

export interface Replayable<T> {
  body: T;
  replayed: boolean;
}

@Injectable()
export class IdempotencyService {
  private readonly entries = new Map<string, Entry>();

  private static fingerprint(body: unknown): string {
    return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
  }

  async run<T>(
    route: string,
    key: string,
    body: unknown,
    create: () => Promise<T> | T,
  ): Promise<Replayable<T>> {
    const id = `${route}:${key}`;
    const seen = this.entries.get(id);

    if (seen) {
      if (seen.fingerprint !== IdempotencyService.fingerprint(body)) {
        throw idempotencyKeyReuse(
          `Idempotency-Key '${key}' was already used with a different request body.`,
        );
      }
      return { body: seen.body as T, replayed: true };
    }

    const created = await create();
    this.entries.set(id, {
      fingerprint: IdempotencyService.fingerprint(body),
      status: 201,
      body: created,
    });
    return { body: created, replayed: false };
  }
}
