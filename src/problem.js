'use strict';

const TYPE_BASE = 'https://marketplace.example/problems';

/**
 * Помилка, яку хендлер кидає свідомо. Все, що не є ProblemError
 * (включно з помилками валідатора), теж приводиться до problem+json
 * у центральному error-handler'і.
 */
class ProblemError extends Error {
  constructor({ status, title, detail, type }) {
    super(detail);
    this.name = 'ProblemError';
    this.status = status;
    this.title = title;
    this.detail = detail;
    this.type = type;
  }
}

const notFound = (detail) =>
  new ProblemError({ status: 404, title: 'Not Found', detail, type: `${TYPE_BASE}/not-found` });

const badRequest = (detail) =>
  new ProblemError({ status: 400, title: 'Bad Request', detail, type: `${TYPE_BASE}/validation-error` });

const idempotencyKeyReuse = (detail) =>
  new ProblemError({
    status: 422,
    title: 'Unprocessable Entity',
    detail,
    type: `${TYPE_BASE}/idempotency-key-reuse`,
  });

const TITLES = {
  400: 'Bad Request',
  404: 'Not Found',
  405: 'Method Not Allowed',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

const SLUGS = {
  400: 'validation-error',
  404: 'not-found',
  405: 'method-not-allowed',
  415: 'unsupported-media-type',
  422: 'unprocessable-entity',
  500: 'internal-server-error',
};

module.exports = { ProblemError, notFound, badRequest, idempotencyKeyReuse, TYPE_BASE, TITLES, SLUGS };
