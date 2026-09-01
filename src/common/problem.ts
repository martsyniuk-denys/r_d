import { Request } from 'express';

export const TYPE_BASE = 'https://marketplace.example/problems';

/** RFC 9457 problem details — the single error shape this API serves. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
}

/**
 * An error a handler raises deliberately. Everything that is not a ProblemError
 * (validator errors included) is normalised into problem+json all the same.
 */
export class ProblemError extends Error {
  readonly status: number;
  readonly title: string;
  readonly detail: string;
  readonly type: string;

  constructor(init: { status: number; title: string; detail: string; type: string }) {
    super(init.detail);
    this.name = 'ProblemError';
    this.status = init.status;
    this.title = init.title;
    this.detail = init.detail;
    this.type = init.type;
  }
}

export const notFound = (detail: string): ProblemError =>
  new ProblemError({ status: 404, title: 'Not Found', detail, type: `${TYPE_BASE}/not-found` });

export const badRequest = (detail: string): ProblemError =>
  new ProblemError({ status: 400, title: 'Bad Request', detail, type: `${TYPE_BASE}/validation-error` });

export const idempotencyKeyReuse = (detail: string): ProblemError =>
  new ProblemError({
    status: 422,
    title: 'Unprocessable Entity',
    detail,
    type: `${TYPE_BASE}/idempotency-key-reuse`,
  });

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  404: 'Not Found',
  405: 'Method Not Allowed',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

const SLUGS: Record<number, string> = {
  400: 'validation-error',
  404: 'not-found',
  405: 'method-not-allowed',
  415: 'unsupported-media-type',
  422: 'unprocessable-entity',
  500: 'internal-server-error',
};

/**
 * The one place that decides what a thrown value looks like on the wire.
 * Shared by the Nest exception filter and the Express error middleware, because
 * express-openapi-validator rejects requests before Nest's pipeline ever runs.
 */
export function toProblem(err: unknown, req: Request): Problem {
  const e = (err ?? {}) as Record<string, unknown>;
  const status = Number(e.status || e.statusCode || 500);
  const title = (e.title as string) || TITLES[status] || 'Error';
  const type = (e.type as string) || `${TYPE_BASE}/${SLUGS[status] || 'error'}`;
  // In express-openapi-validator `message` is already the assembled detail,
  // e.g. "request/headers must have required property 'idempotency-key'".
  const detail = (e.detail as string) || (e.message as string) || 'Unexpected error.';

  if (status >= 500 && !(err instanceof ProblemError)) {
    console.error('[problem]', status, detail);
  }

  return { type, title, status, detail, instance: req.originalUrl };
}
