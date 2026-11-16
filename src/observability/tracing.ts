import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ExpressInstrumentation, ExpressLayerType } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor, NoopSpanProcessor, SpanProcessor } from '@opentelemetry/sdk-trace';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

import { onTracingShutdown } from './tracing-shutdown';

// The first module main.ts loads. Auto-instrumentation works by patching http,
// express and pg as they are required, so this has to run before Nest, the pg
// pool or anything that imports them: a module required before sdk.start() is a
// module nobody patched, and its requests have no spans and no trace_id in logs.
//
// The SDK starts whether or not there is somewhere to send spans. Without
// OTEL_EXPORTER_OTLP_ENDPOINT spans are still created — the trace_id the logs
// carry comes from them — they are just not exported. That takes a processor that
// drops them: with an empty list NodeSDK registers no TracerProvider at all, the
// API falls back to its no-op tracer, and every log line says
// trace_id=00000000000000000000000000000000.

// The scrape is not a request anybody asked about; tracing it would put one
// trace every few seconds next to the ones that matter.
const UNTRACED = new Set(['/metrics']);

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

// An empty or non-numeric OTEL_BSP_SCHEDULE_DELAY would reach setTimeout as 0 or
// NaN, i.e. an export every millisecond; anything but a positive integer is 1 s.
const configuredDelay = Number.parseInt(process.env.OTEL_BSP_SCHEDULE_DELAY ?? '', 10);
const scheduleDelayMs = Number.isInteger(configuredDelay) && configuredDelay > 0 ? configuredDelay : 1000;

// Signals this process does not send over OTLP: metrics are scraped from
// /metrics by Prometheus, logs go to stdout.
process.env.OTEL_METRICS_EXPORTER ??= 'none';
process.env.OTEL_LOGS_EXPORTER ??= 'none';

const spanProcessors: SpanProcessor[] =
  endpoint === undefined || endpoint === ''
    ? [new NoopSpanProcessor()]
    : [
        // The exporter appends /v1/traces to OTEL_EXPORTER_OTLP_ENDPOINT itself.
        new BatchSpanProcessor({
          exporter: new OTLPTraceExporter(),
          scheduledDelayMillis: scheduleDelayMs,
        }),
      ];

const sdk = new NodeSDK({
  resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'marketplace-api' }),
  spanProcessors,
  instrumentations: [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (req) => UNTRACED.has((req.url ?? '').split('?')[0]),
    }),
    // One span per Express middleware (the body parser, each step of the OpenAPI
    // validator…) is a dozen spans per request that answer no question; the
    // route handler span stays, and http.route on the server span comes from it.
    new ExpressInstrumentation({ ignoreLayersType: [ExpressLayerType.MIDDLEWARE] }),
    new PgInstrumentation(),
  ],
});

sdk.start();

let stopped: Promise<void> | undefined;

// Batched spans that are still in memory are sent here; a process that exits
// without it loses the last second of its traces — usually the interesting one.
onTracingShutdown(() => {
  stopped ??= sdk.shutdown().catch(() => undefined);
  return stopped;
});
