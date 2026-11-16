import { AsyncLocalStorage } from 'node:async_hooks';

import { NextFunction, Request, Response } from 'express';

// What a request is about, beyond the trace: who sent it, for which tenant, under
// which Idempotency-Key. It lives in AsyncLocalStorage, so the logger reads it
// from wherever the code happens to be — the repository three layers down does
// not take a req, and does not need one.
//
// The trace_id is not here: it belongs to the active OpenTelemetry span, which
// has its own AsyncLocalStorage. A second id kept next to it would be a second
// key that no trace backend can find.
export interface RequestContext {
  userId?: string;
  tenant?: string;
  idempotencyKey?: string;
  fault?: Fault;
}

// Failure modes a demo can ask for (FAULT_INJECTION=1 only): a slow database
// call and a failing one. They are carried by the context, not by arguments, so
// the deepest layer reading them is itself a proof that the context got there.
export type Fault = 'slow' | 'error';

const storage = new AsyncLocalStorage<RequestContext>();

const FAULTS = new Set<string>(['slow', 'error']);

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

// Called by AccessTokenGuard once the token is verified: the store object is the
// request's own, so every line logged after this, in any layer, carries the user.
export function bindUser(userId: string): void {
  const context = storage.getStore();
  if (context !== undefined) context.userId = userId;
}

export function injectedFault(): Fault | undefined {
  return storage.getStore()?.fault;
}

// The first middleware of the app: everything after it, down to the repository,
// runs inside this request's store. Express calls the rest of the chain from
// inside storage.run(), and the async work it starts inherits the store.
export function requestContext() {
  const faultsEnabled = process.env.FAULT_INJECTION === '1';

  return (req: Request, _res: Response, next: NextFunction): void => {
    const fault = req.header('x-fault');
    const context: RequestContext = {
      tenant: req.header('x-tenant-id') ?? undefined,
      idempotencyKey: req.header('idempotency-key') ?? undefined,
      fault: faultsEnabled && fault !== undefined && FAULTS.has(fault) ? (fault as Fault) : undefined,
    };
    storage.run(context, next);
  };
}

