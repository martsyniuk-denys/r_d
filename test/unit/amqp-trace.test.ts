import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';

import { captureTraceContext, inConsumeSpan, inPublishSpan } from '../../src/observability/amqp-trace';

// The hand-offs of the contour without a broker or a database: what the API's
// transaction stores in the outbox row is what the relay continues, and what the
// relay puts in the headers is what the consumer continues — one trace id, each
// span the child of the one before.
describe('trace context through the outbox and AMQP headers', () => {
  const exporter = new InMemorySpanExporter();
  const processor = new SimpleSpanProcessor({ exporter });
  const sdk = new NodeSDK({ spanProcessors: [processor], instrumentations: [] });
  // The processor hands an ended span to the exporter asynchronously.
  const finished = async () => {
    await processor.forceFlush();
    return exporter.getFinishedSpans();
  };
  const tracer = trace.getTracer('test');

  beforeAll(() => sdk.start());
  afterAll(() => sdk.shutdown());
  beforeEach(() => exporter.reset());

  it('stores nothing outside a span', () => {
    expect(captureTraceContext()).toBeNull();
  });

  it('request → outbox row → publish → consume is one trace, parent by parent', async () => {
    const stored = await tracer.startActiveSpan('POST /orders', async (request) => {
      const carrier = captureTraceContext();
      request.end();
      return carrier;
    });
    expect(stored?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

    const headers = await inPublishSpan(
      { exchange: 'marketplace.events', routingKey: 'order.placed', messageId: 'evt-1', stored },
      async (outgoing) => outgoing,
    );
    await inConsumeSpan(
      { queue: 'fulfilment.order-placed', routingKey: 'order.placed', messageId: 'evt-1', headers: { ...headers, 'x-delivery-count': 0 } },
      async () => undefined,
    );

    const spans = await finished();
    const byName = (name: string) => spans.find((s) => s.name === name)!;
    const request = byName('POST /orders');
    const publish = byName('order.placed publish');
    const consume = byName('fulfilment.order-placed process');

    expect(new Set(spans.map((s) => s.spanContext().traceId))).toEqual(new Set([request.spanContext().traceId]));
    expect(publish.parentSpanContext?.spanId).toBe(request.spanContext().spanId);
    expect(publish.kind).toBe(SpanKind.PRODUCER);
    expect(consume.parentSpanContext?.spanId).toBe(publish.spanContext().spanId);
    expect(consume.kind).toBe(SpanKind.CONSUMER);
  });

  it('a delivery without headers starts a trace of its own', async () => {
    await inConsumeSpan({ queue: 'q', routingKey: 'order.placed', messageId: null, headers: undefined }, async () => undefined);
    const [span] = await finished();
    expect(span.parentSpanContext).toBeUndefined();
  });

  it('marks the span as failed and rethrows', async () => {
    await expect(
      inConsumeSpan({ queue: 'q', routingKey: 'order.placed', messageId: 'evt-2', headers: undefined }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await finished())[0].status.code).toBe(SpanStatusCode.ERROR);
  });
});
