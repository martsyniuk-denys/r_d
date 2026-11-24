import { SpanStatusCode, trace } from '@opentelemetry/api';
import { Request } from 'express';

import { layerLogger } from '../observability/logger';

const problemLog = layerLogger('http.problem');

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

export const unauthorized = (detail: string): ProblemError =>
  new ProblemError({ status: 401, title: 'Unauthorized', detail, type: `${TYPE_BASE}/unauthorized` });

export const forbidden = (detail: string): ProblemError =>
  new ProblemError({ status: 403, title: 'Forbidden', detail, type: `${TYPE_BASE}/forbidden` });

export const conflict = (detail: string): ProblemError =>
  new ProblemError({ status: 409, title: 'Conflict', detail, type: `${TYPE_BASE}/conflict` });

export const idempotencyKeyReuse = (detail: string): ProblemError =>
  new ProblemError({
    status: 422,
    title: 'Unprocessable Entity',
    detail,
    type: `${TYPE_BASE}/idempotency-key-reuse`,
  });

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

const SLUGS: Record<number, string> = {
  400: 'validation-error',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not-found',
  405: 'method-not-allowed',
  409: 'conflict',
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
    // The active span here is Express's request handler span, a child of the
    // server span. The server span turns ERROR by itself from the 5xx; this one
    // gets the exception event and the ERROR status, so the reason sits on the
    // span directly under the root in the trace view.
    const span = trace.getActiveSpan();
    span?.recordException(err instanceof Error ? err : String(err));
    span?.setStatus({ code: SpanStatusCode.ERROR, message: detail });
    problemLog.error({ err }, detail);
  }

  return { type, title, status, detail, instance: req.originalUrl };
}
