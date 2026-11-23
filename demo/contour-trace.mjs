// One trace_id across three processes and two hand-offs that are not calls:
//
//   POST /orders  (traceparent from here)
//     API      checkout tx ── outbox row keeps the trace context ── COMMIT
//     relay    "order.placed publish"            PRODUCER, child of the request
//     consumer "fulfilment.order-placed process" CONSUMER, child of the publish
//              → its own outbox row → relay "order.status_changed publish"
//              → API "api.realtime process"      (the push to the owner's stream)
//
//   POST /payments/webhook  (a second traceparent: the provider's request)
//     API → relay "order.status_changed publish" → API "api.realtime process"
//
// Each trace is fetched from Jaeger by the trace id this script chose, and every
// span in it must hang off another span of the same trace (or off the caller's
// span from the header): no orphans, no second trace where the hand-off happened.
//
//   docker compose --profile obs up -d --wait
//   docker compose run --rm demo demo/contour-trace.mjs
//
// Exit 0 only if both traces are whole.
import { randomBytes, randomUUID } from 'node:crypto';

import { BASE_URL, BUYER, Invariants, login, placeOrder, productsInStock, report, run, waitForStatus, webhook, webhookSecret } from './lib/api-client.mjs';

const TRACES = (process.env.TRACE_API_URL ?? 'http://localhost:22904').replace(/\/$/, '');
const DEADLINE_MS = 30_000;

function traceparent() {
  const traceId = randomBytes(16).toString('hex');
  const parentId = randomBytes(8).toString('hex');
  return { traceId, parentId, header: `00-${traceId}-${parentId}-01` };
}

// Jaeger's query API: { data: [{ traceID, spans: [{ spanID, operationName, references, processID }], processes }] }
async function fetchTrace(traceId) {
  try {
    const response = await fetch(`${TRACES}/api/traces/${traceId}`);
    if (!response.ok) return undefined;
    return (await response.json()).data?.[0];
  } catch (error) {
    throw new Error(`trace backend at ${TRACES} unreachable (${error.cause?.code ?? error.message}) — start it: docker compose --profile obs up -d --wait`);
  }
}

// Spans arrive in batches from three processes; poll until every expected one is in.
async function waitForTrace(traceId, expected) {
  const deadline = Date.now() + DEADLINE_MS;
  for (;;) {
    const trace = await fetchTrace(traceId);
    const spans = describe(trace);
    const missing = expected.filter(([service, name]) => !spans.some((s) => s.service === service && s.name === name));
    if (missing.length === 0 || Date.now() > deadline) return { spans, missing };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function describe(trace) {
  if (trace === undefined) return [];
  return trace.spans.map((span) => ({
    id: span.spanID,
    name: span.operationName,
    service: trace.processes[span.processID]?.serviceName ?? '?',
    parent: span.references?.find((r) => r.refType === 'CHILD_OF')?.spanID,
    kind: span.tags?.find((t) => t.key === 'span.kind')?.value,
  }));
}

function checkTrace(invariants, label, tp, expected, { spans, missing }) {
  const ids = new Set(spans.map((s) => s.id));
  const orphans = spans.filter((s) => s.parent !== undefined && !ids.has(s.parent) && s.parent !== tp.parentId);
  const services = [...new Set(spans.map((s) => s.service))].sort();
  const chain = expected.map(([service, name]) => {
    const span = spans.find((s) => s.service === service && s.name === name);
    const parent = spans.find((s) => s.id === span?.parent);
    return `    ${span ? 'ok  ' : 'MISS'} ${service.padEnd(21)} ${name.padEnd(36)} ← ${parent ? `${parent.service} ${parent.name}` : span?.parent === tp.parentId ? 'caller (traceparent header)' : '-'}`;
  });
  console.log(`\n${label}: trace ${tp.traceId}, ${spans.length} spans from ${services.join(', ')}`);
  console.log(chain.join('\n'));
  invariants.check(`${label}: every hop in one trace`, missing.length === 0, missing.length === 0 ? `${expected.length} hops found` : `missing ${missing.map((m) => m.join(' ')).join('; ')}`);
  invariants.check(`${label}: no orphan spans`, spans.length > 0 && orphans.length === 0, `${orphans.length} spans whose parent is not in the trace`);
  return { services, spans: spans.length };
}

run(async () => {
  const invariants = new Invariants();
  const secret = webhookSecret();
  console.log(`contour trace against ${BASE_URL}, traces from ${TRACES}`);

  const buyer = await login(BUYER);
  const [productId] = await productsInStock(1);

  const placing = traceparent();
  const created = await placeOrder(buyer, [{ product_id: productId, qty: 1 }], randomUUID(), { traceparent: placing.header });
  const order = created.body;
  invariants.check('create', created.status === 201, `POST /orders → ${created.status} ${order?.id}`);
  const confirmed = await waitForStatus(buyer, order.id, 'confirmed');
  invariants.check('consumer confirmed it', confirmed === 'confirmed', `status ${confirmed}`);

  const paying = traceparent();
  const paid = await webhook(
    secret,
    { event_id: `evt_${randomUUID()}`, order_id: order.id, amount_cents: order.total_cents, currency: order.currency, outcome: 'succeeded' },
    { headers: { traceparent: paying.header } },
  );
  invariants.check('webhook', paid.status === 200 && paid.body?.order_status === 'paid', `POST /payments/webhook → ${paid.status} ${paid.body?.order_status}`);

  const placedHops = [
    ['marketplace-api', 'POST /orders'],
    ['marketplace-relay', 'order.placed publish'],
    ['marketplace-consumer', 'fulfilment.order-placed process'],
    ['marketplace-relay', 'order.status_changed publish'],
    ['marketplace-api', 'api.realtime process'],
  ];
  const paidHops = [
    ['marketplace-api', 'POST /payments/webhook'],
    ['marketplace-relay', 'order.status_changed publish'],
    ['marketplace-api', 'api.realtime process'],
  ];
  const placed = checkTrace(invariants, 'checkout', placing, placedHops, await waitForTrace(placing.traceId, placedHops));
  const payment = checkTrace(invariants, 'payment', paying, paidHops, await waitForTrace(paying.traceId, paidHops));

  console.log('');
  report({
    order: order.id,
    checkout_trace: placing.traceId,
    checkout_services: placed.services.length,
    payment_trace: paying.traceId,
    payment_services: payment.services.length,
    ui: `http://127.0.0.1:22904/trace/${placing.traceId}`,
  });
  return invariants.failures.length === 0 ? 0 : 1;
});
