import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestStore {
  readonly requestId: string;
  readonly startedAt: number;
}

const SAFE_REQUEST_ID = /^[\x20-\x7e]{1,200}$/;

const storage = new AsyncLocalStorage<RequestStore>();

export const RequestContext = {
  run<T>(store: RequestStore, callback: () => T): T {
    return storage.run(store, callback);
  },

  get(): RequestStore | undefined {
    return storage.getStore();
  },

  requestId(): string | undefined {
    return storage.getStore()?.requestId;
  },
} as const;

export function getRequestId(): string | undefined {
  return RequestContext.requestId();
}

export function resolveRequestId(incoming: string | string[] | undefined): string {
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming;

  return typeof candidate === 'string' && SAFE_REQUEST_ID.test(candidate.trim())
    ? candidate.trim()
    : randomUUID();
}

export function createRequestStore(requestId: string): RequestStore {
  return { requestId, startedAt: Date.now() };
}
