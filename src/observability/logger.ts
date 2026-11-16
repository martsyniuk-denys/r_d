import { trace } from '@opentelemetry/api';
import pino, { Logger } from 'pino';

import { currentContext } from './context';

// Every path that can carry a credential, written out. pino's redact does not
// look for "password" anywhere in the object: it hides exactly these paths, and a
// wildcard covers exactly one level. `*.password` hides body.password, but not
// body.account.password — a nested object without a path of its own goes into
// the log as it is. Adding a field that holds a secret means adding its path here.
export const REDACT_PATHS = [
  // the request line (see request-log.ts): headers and the parsed body
  'req.headers.authorization',
  'req.headers["proxy-authorization"]',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.body.password',
  'req.body.refresh_token',
  'req.body.access_token',
  // the same fields when a layer logs a DTO of its own
  '*.password',
  '*.refresh_token',
  '*.access_token',
  'password',
  'refresh_token',
  'access_token',
];

// The logger is created when main.ts is still importing, before the env schema
// runs. A level pino does not know (LOG_LEVEL=INFO) would throw right here, with a
// raw stack instead of the "Startup aborted … LOG_LEVEL" the schema prints; so an
// unknown value falls back to info, and validate() names it a moment later.
const REQUESTED = process.env.LOG_LEVEL ?? 'info';
const LEVEL = REQUESTED in pino.levels.values ? REQUESTED : 'info';

// One JSON object per line on stdout; the collector, not the application, decides
// where it goes from there. pino-pretty is for a human at a terminal (pipe into
// it locally); it is not a dependency of the process.
export const logger: Logger = pino({
  level: LEVEL,
  base: { service: process.env.OTEL_SERVICE_NAME ?? 'marketplace-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
  // Read on every line, from the two AsyncLocalStorages that are current at the
  // moment of the call: OpenTelemetry's (the active span) and the request's own.
  // No caller passes any of these, so no caller can pass the wrong one.
  mixin() {
    const fields: Record<string, string> = {};
    const span = trace.getActiveSpan()?.spanContext();
    if (span !== undefined) {
      fields.trace_id = span.traceId;
      fields.span_id = span.spanId;
    }
    const context = currentContext();
    if (context?.userId !== undefined) fields.userId = context.userId;
    if (context?.tenant !== undefined) fields.tenant = context.tenant;
    if (context?.idempotencyKey !== undefined) fields.idempotencyKey = context.idempotencyKey;
    return fields;
  },
});

// The component a line comes from. Created once per class, not per request: the
// layer is static, and everything per-request comes from the mixin.
export function layerLogger(layer: string): Logger {
  return logger.child({ layer });
}
