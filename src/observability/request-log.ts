import { AsyncResource } from 'node:async_hooks';

import { NextFunction, Request, Response } from 'express';

import { layerLogger } from './logger';
import { httpDuration, httpRequests, registry } from './metrics';

const log = layerLogger('http');

// The template the request was routed to, as Express knows it after routing:
// '/orders/:orderId'. A request that was answered before routing (a 400 from the
// OpenAPI validator) still has the template the validator matched; one that
// matched nothing at all is 'unmatched' — a single value, whatever the path was.
function routeOf(req: Request): string {
  if (req.route?.path !== undefined) return `${req.baseUrl}${req.route.path}`;
  const matched = (req as Request & { openapi?: { expressRoute?: string } }).openapi?.expressRoute;
  return matched ?? 'unmatched';
}

// What a request that the client abandoned before any response is labelled with:
// nginx's "client closed request". No response was sent, so there is no real
// code to report, and 200 (the default of res.statusCode) would be a lie.
const CLIENT_CLOSED = 499;

// One line and one observation per request, written when the response is done.
// Mounted before the body parser, so a request the parser rejects (malformed
// JSON → 400) is still counted and logged.
//
// 'finish' alone misses every request the client walked away from: an SSE stream
// whose tab was closed, a call that timed out on the client during a slow query.
// Those end with 'close' and no 'finish' — and they are the requests a Rate or
// Errors panel must not lose. 'close' also follows every 'finish', hence the guard.
//
// The listener is bound to the request's async context. After an abort, 'close'
// is emitted by the socket being torn down, outside that context: measured, the
// line kept its trace_id (OpenTelemetry binds the response emitter to its own
// context) but lost the userId from the request's store. AsyncResource.bind
// carries both.
export function observeRequests() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = process.hrtime.bigint();
    let recorded = false;

    const record = AsyncResource.bind((): void => {
      if (recorded) return;
      recorded = true;

      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const aborted = !res.writableFinished;
      const status = aborted && !res.headersSent ? CLIENT_CLOSED : res.statusCode;
      const labels = { method: req.method, route: routeOf(req), status: String(status) };
      httpRequests.inc(labels);
      httpDuration.observe(labels, seconds);

      log.info(
        {
          req: { method: req.method, url: req.originalUrl, route: labels.route, headers: req.headers, body: req.body },
          res: { status },
          aborted,
          duration_ms: Math.round(seconds * 1000),
        },
        aborted ? 'request aborted by the client' : 'request completed',
      );
    });

    res.on('finish', record);
    res.on('close', record);

    next();
  };
}

export function metricsEndpoint(_req: Request, res: Response, next: NextFunction): void {
  registry
    .metrics()
    .then((body) => res.type(registry.contentType).end(body))
    .catch(next);
}
