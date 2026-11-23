import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

// RED: Rate and Errors from one counter, Duration from one histogram, with the
// same three labels. Every label value comes from a closed set:
//   method — the HTTP verbs the API routes
//   route  — the route template (/orders/:orderId), never the raw path, so a
//            hundred order ids are one series, not a hundred
//   status — the HTTP code as sent
// A label fed from a raw path, an id or a user is a new time series per value,
// and Prometheus keeps every one of them in memory until retention drops it.
export const registry = new Registry();

collectDefaultMetrics({ register: registry });

// Seconds. The histogram can only say "slower than the last finite bucket": once
// a request crosses it, it lands in +Inf, and histogram_quantile() answers with
// that last bucket — a flat, healthy-looking line exactly when things are worst.
// So the top must sit above the worst case this service can produce: the slowest
// request it serves on purpose (the slow-database fault, 1.2 s) plus a cold pool,
// with headroom for a database under load; 10 s is also past the point at which
// a client gives up and retries. Below 0.5 s the steps are dense, because that is
// where the p50 of a healthy API lives.
export const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export const httpRequests = new Counter({
  name: 'http_requests_total',
  help: 'HTTP requests served, by method, route template and status code.',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Time from the request reaching the app to the last byte of the response, in seconds.',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: DURATION_BUCKETS,
  registers: [registry],
});

// The background half of the contour, from the two processes that do it. Each
// serves its own /metrics (metrics-server.ts); Prometheus tells them apart by job.
//
// Transitions are counted by the relay, when it publishes order.status_changed:
// that event exists only for a transition that committed (it is written in the
// same transaction), so a rolled-back one is never counted — which a counter
// next to the UPDATE could not promise. A relay that dies between publish and
// mark publishes the row again and counts it twice; that is the at-least-once
// the consumers already absorb, and a counter may be off by the same one.
// from/to are order statuses — a closed set of six.
export const orderTransitions = new Counter({
  name: 'order_status_transitions_total',
  help: 'Committed order status transitions, counted when the relay publishes order.status_changed.',
  labelNames: ['from', 'to'] as const,
  registers: [registry],
});

export const outboxPublished = new Counter({
  name: 'outbox_events_published_total',
  help: 'Outbox rows the broker confirmed, by event type.',
  labelNames: ['type'] as const,
  registers: [registry],
});

// outcome: ack | dead-letter | requeue — the three ways a delivery is settled.
export const messagesConsumed = new Counter({
  name: 'messages_consumed_total',
  help: 'Deliveries settled by a consumer, by queue and outcome.',
  labelNames: ['queue', 'outcome'] as const,
  registers: [registry],
});

export const messageDuration = new Histogram({
  name: 'message_processing_duration_seconds',
  help: 'Time from a delivery reaching the consumer to its settlement, in seconds.',
  labelNames: ['queue', 'outcome'] as const,
  buckets: DURATION_BUCKETS,
  registers: [registry],
});
