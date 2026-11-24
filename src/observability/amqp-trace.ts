import {
  Context,
  ROOT_CONTEXT,
  Span,
  SpanKind,
  SpanStatusCode,
  TextMapGetter,
  context,
  propagation,
  trace,
} from '@opentelemetry/api';

// One trace from the HTTP request to the consumer, across three processes and two
// hand-offs that are not calls:
//
//   API      POST /orders ── COMMIT ── outbox.trace_context = { traceparent }
//   relay    reads the row later, in its own loop  →  span "<type> publish"
//            (PRODUCER, child of the stored context), AMQP headers.traceparent
//   consumer headers.traceparent  →  span "<queue> process" (CONSUMER), and the
//            SQL, the logs and the next outbox row inside it
//
// The relay cannot use whatever context is active when it publishes: that is its
// polling loop, not the request. So the context travels with the row, written in
// the same transaction as the event (it is part of the event's envelope, not of
// its payload — the consumer's contract does not change).

export type TraceCarrier = Record<string, string>;

const tracer = trace.getTracer('marketplace-messaging');

// AMQP table values: amqplib decodes long strings as string, but a producer that
// sends bytes gets a Buffer.
const headerGetter: TextMapGetter<Record<string, unknown>> = {
  keys: (carrier) => Object.keys(carrier),
  get: (carrier, key) => {
    const value = carrier[key];
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    return undefined;
  },
};

// The context active now, as the carrier the outbox stores; null when there is
// no span to continue (a seed, a script), so the column says "no trace" honestly.
export function captureTraceContext(): TraceCarrier | null {
  const carrier: TraceCarrier = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent === undefined ? null : carrier;
}

function contextFrom(carrier: Record<string, unknown> | null | undefined): Context {
  return carrier == null ? ROOT_CONTEXT : propagation.extract(ROOT_CONTEXT, carrier, headerGetter);
}

async function run<T>(span: Span, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    span.recordException(error instanceof Error ? error : String(error));
    span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    span.end();
  }
}

// The relay's publish of one outbox row: a PRODUCER span under the stored
// context, and the headers that carry the span on to whoever consumes it.
export function inPublishSpan<T>(
  message: { exchange: string; routingKey: string; messageId: string; stored: TraceCarrier | null },
  fn: (headers: TraceCarrier) => Promise<T>,
): Promise<T> {
  const parent = contextFrom(message.stored);
  return tracer.startActiveSpan(
    `${message.routingKey} publish`,
    {
      kind: SpanKind.PRODUCER,
      attributes: {
        'messaging.system': 'rabbitmq',
        'messaging.operation.type': 'send',
        'messaging.destination.name': message.exchange,
        'messaging.rabbitmq.destination.routing_key': message.routingKey,
        'messaging.message.id': message.messageId,
      },
    },
    parent,
    (span) => {
      const headers: TraceCarrier = {};
      propagation.inject(context.active(), headers);
      return run(span, () => fn(headers));
    },
  );
}

// Handling of one delivery: a CONSUMER span under the context in its headers (a
// fresh trace when there is none). Everything inside — the transaction, the logs,
// the outbox row of the next event — belongs to it.
export function inConsumeSpan<T>(
  message: { queue: string; routingKey: string; messageId: string | null; headers: Record<string, unknown> | undefined },
  fn: () => Promise<T>,
): Promise<T> {
  const parent = contextFrom(message.headers);
  return tracer.startActiveSpan(
    `${message.queue} process`,
    {
      kind: SpanKind.CONSUMER,
      attributes: {
        'messaging.system': 'rabbitmq',
        'messaging.operation.type': 'process',
        'messaging.destination.name': message.queue,
        'messaging.rabbitmq.destination.routing_key': message.routingKey,
        ...(message.messageId === null ? {} : { 'messaging.message.id': message.messageId }),
      },
    },
    parent,
    (span) => run(span, fn),
  );
}

export function activeTraceId(): string | undefined {
  const span = trace.getActiveSpan()?.spanContext();
  return span === undefined || !trace.isSpanContextValid(span) ? undefined : span.traceId;
}
