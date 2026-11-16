// demo:trace — one key opens both doors.
//
// One checkout arrives with a traceparent of our own and fails in the database
// (X-Fault: error → Postgres raises division_by_zero → 500). Then:
//
//   the trace backend is asked for the trace by the trace-id from the header —
//     it has it, the server span's parent is the header's parent-id, every other
//     span hangs off a span of the same trace, and the server span is ERROR
//   the log of the same request (found by its Idempotency-Key, not by trace_id)
//     carries that same trace_id, and every span_id it names is a span of it
//
// The API exports in batches every 200 ms (OTEL_BSP_SCHEDULE_DELAY), so the
// backend is polled until the span count stops growing, with a deadline.

import { Invariants, ObservedApi, idempotencyKey, login, prepare, report, required, runDemo, traceparent } from './lib/observed-api.mjs';

const POLL_MS = 500;
const DEADLINE_MS = 20_000;

runDemo(async () => {
  const invariants = new Invariants();
  const traces = required('TRACE_API_URL');
  required('OTEL_EXPORTER_OTLP_ENDPOINT');
  const { buyer, productId } = await prepare('demo-trace');
  const api = await ObservedApi.start();

  try {
    const token = await login(api, buyer);
    const tp = traceparent();
    const key = idempotencyKey();
    const reply = await api.call('POST', '/orders', {
      token,
      body: { items: [{ product_id: productId, qty: 1 }] },
      headers: { traceparent: tp.header, 'Idempotency-Key': key, 'X-Fault': 'error' },
    });
    await api.waitForLines((json) => json.idempotencyKey === key && json.msg === 'request completed', 1);
    console.log(`POST /orders, traceparent ${tp.header} → ${reply.status}`);

    const trace = await fetchTrace(traces, tp.traceId);
    const spans = trace?.spans ?? [];
    const ids = new Set(spans.map((s) => s.spanID));
    const parentOf = (span) => span.references?.find((r) => r.refType === 'CHILD_OF')?.spanID;
    const tag = (span, key) => span.tags?.find((t) => t.key === key)?.value;

    const server = spans.find((s) => tag(s, 'span.kind') === 'server');
    // a span whose parent is neither in this trace nor the caller's span from the header
    const orphans = spans.filter((s) => {
      const parent = parentOf(s);
      return parent !== undefined && !ids.has(parent) && parent !== tp.parentId;
    });
    const roots = spans.filter((s) => parentOf(s) === undefined || parentOf(s) === tp.parentId);

    const traceMatchesHeader = trace !== undefined && trace.traceID === tp.traceId && server !== undefined && parentOf(server) === tp.parentId;
    const statusError = server !== undefined && tag(server, 'otel.status_code') === 'ERROR';

    const logLines = api.lines.filter((line) => line.json?.idempotencyKey === key).map((line) => line.json);
    const logTraceIds = new Set(logLines.map((json) => json.trace_id));
    const logSpanIds = new Set(logLines.map((json) => json.span_id).filter(Boolean));
    const spansFromLog = [...logSpanIds].filter((id) => ids.has(id)).length;
    const traceMatchesLog =
      trace !== undefined && logLines.length > 0 && logTraceIds.size === 1 && logTraceIds.has(trace.traceID) && spansFromLog === logSpanIds.size;

    for (const span of spans) {
      const status = tag(span, 'otel.status_code');
      console.log(`  ${span.spanID} ← ${parentOf(span) ?? '-'}  ${span.operationName}${status === undefined ? '' : `  [${status}]`}`);
    }
    for (const json of logLines) console.log(`  log ${json.layer}: trace_id=${json.trace_id} span_id=${json.span_id} "${json.msg}"`);
    console.log('');

    invariants.check('the request failed with a 5xx', reply.status >= 500, `${reply.status}`);
    invariants.check('the backend has the trace by the header’s trace-id', trace !== undefined, trace === undefined ? 'not found' : trace.traceID);
    invariants.check('server span + at least one nested span', server !== undefined && spans.length >= 2, `${spans.length} spans`);
    invariants.check('the server span continues the caller’s span', traceMatchesHeader, server === undefined ? 'no server span' : `parent ${parentOf(server)}`);
    invariants.check('one root, no orphans', orphans.length === 0 && roots.length === 1, `${roots.length} root(s), ${orphans.length} orphan(s)`);
    invariants.check('the server span is ERROR', statusError, server === undefined ? '-' : `${tag(server, 'otel.status_code')}`);
    invariants.check('the log names the same trace', traceMatchesLog, `${logLines.length} lines, trace_ids ${[...logTraceIds].join(',')}`);
    invariants.check('every span_id in the log is a span of it', spansFromLog === logSpanIds.size && logSpanIds.size > 0, `${spansFromLog}/${logSpanIds.size}`);
    console.log('');

    report({
      status: reply.status,
      spans: spans.length,
      'orphan-spans': orphans.length,
      'trace-matches-header': traceMatchesHeader ? 1 : 0,
      'trace-matches-log': traceMatchesLog ? 1 : 0,
      'log-lines': logLines.length,
      'span-status-error': statusError ? 1 : 0,
    });

    if (invariants.broken > 0) console.error(api.dump());
    return invariants.broken === 0 ? 0 : 1;
  } finally {
    await api.stop();
  }
});

// Jaeger's query API: GET /api/traces/<trace-id> → { data: [{ traceID, spans }] },
// 404 until the first span of the trace has arrived.
async function fetchTrace(base, traceId) {
  const deadline = Date.now() + DEADLINE_MS;
  let previous = -1;
  let found;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/traces/${traceId}`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        found = (await response.json())?.data?.[0];
        const count = found?.spans?.length ?? 0;
        const hasServer = found?.spans?.some((s) => s.tags?.some((t) => t.key === 'span.kind' && t.value === 'server'));
        if (hasServer && count === previous) return found;
        previous = count;
      }
    } catch {
      // not reachable yet, or a slow answer: try again until the deadline
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return found;
}
