import { SpanStatusCode, trace } from '@opentelemetry/api';

const tracer = trace.getTracer('marketplace-api');

// A manual span around a piece of work the auto-instrumentation cannot name: it
// sees the HTTP request and the SQL, not "placing an order". The span becomes the
// active one for everything inside fn, so the logs written there carry its id.
export function inSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    try {
      return await fn();
    } catch (error) {
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}
