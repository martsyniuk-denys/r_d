import { Request } from 'express';

export const TYPE_BASE = 'https://marketplace.example/problems';

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
}

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

export function toProblem(err: unknown, req: Request): Problem {
  const e = (err ?? {}) as Record<string, unknown>;
  const status = Number(e.status || e.statusCode || 500);
  const title = (e.title as string) || TITLES[status] || 'Error';
  const type = (e.type as string) || `${TYPE_BASE}/${SLUGS[status] || 'error'}`;
  const detail = (e.detail as string) || (e.message as string) || 'Unexpected error.';

  if (status >= 500 && !(err instanceof ProblemError)) {
    console.error('[problem]', status, detail);
  }

  return { type, title, status, detail, instance: req.originalUrl };
}
