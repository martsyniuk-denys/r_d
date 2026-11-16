// demo:logs — the correlator lives in the context, not in function arguments.
//
//   1. one checkout with its own traceparent: every line it produced, in every
//      layer down to the repository, carries one trace_id — the header's
//   2. a burst of BURST identical checkouts in parallel, each with its own
//      traceparent: the log groups into exactly BURST traces of equal size.
//      A "current request" kept in a module variable would be overwritten by the
//      next request and smear lines across groups (burst-uneven > 0); a context
//      lost on a callback would leave lines without a trace (an extra group)
//   3. a login carrying Authorization: Bearer <marker 1> and a password that is
//      marker 2: the request line is in the log, neither marker is
//
// The lines of a request are found by its Idempotency-Key, which the API keeps in
// the same AsyncLocalStorage as the user — not by the trace_id being checked.

import { randomBytes } from 'node:crypto';

import { Invariants, ObservedApi, idempotencyKey, login, prepare, report, runDemo, traceparent } from './lib/observed-api.mjs';

const BURST = 10;
const TENANT = 'demo-tenant';

runDemo(async () => {
  const invariants = new Invariants();
  const { buyer, productId } = await prepare('demo-logs');
  const api = await ObservedApi.start();

  try {
    const token = await login(api, buyer);
    const order = { items: [{ product_id: productId, qty: 2 }] };
    const checkout = (tp, key) =>
      api.call('POST', '/orders', {
        token,
        body: order,
        headers: { traceparent: tp.header, 'Idempotency-Key': key, 'X-Tenant-Id': TENANT },
      });
    const completed = (traceId) => (json) => json.trace_id === traceId && json.msg === 'request completed';

    // 1. one request
    const single = traceparent();
    const singleKey = idempotencyKey();
    const singleReply = await checkout(single, singleKey);
    await api.waitForLines(completed(single.traceId), 1);
    const singleLines = api.lines.filter((line) => line.json?.idempotencyKey === singleKey).map((line) => line.json);
    const singleTraces = new Set(singleLines.map((json) => json.trace_id));
    const layers = new Set(singleLines.map((json) => json.layer).filter(Boolean));
    const withUser = singleLines.filter((json) => json.userId === buyer.id && json.tenant === TENANT).length;

    console.log(`single: ${singleReply.status}, ${singleLines.length} lines, layers: ${[...layers].join(' → ')}`);

    // 2. the burst: same request, its own traceparent and key each
    const from = api.lines.length;
    const sent = Array.from({ length: BURST }, () => ({ tp: traceparent(), key: idempotencyKey() }));
    const replies = await Promise.all(sent.map(({ tp, key }) => checkout(tp, key)));
    for (const { tp } of sent) await api.waitForLines(completed(tp.traceId), 1);
    const window = api.lines.slice(from).filter((line) => line.json !== null && line.json.layer !== undefined).map((line) => line.json);

    const groups = new Map();
    for (const json of window) {
      const id = json.trace_id ?? 'none';
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(json);
    }
    const sizes = [...groups.values()].map((lines) => lines.length);
    const typical = mode(sizes);
    const uneven = sizes.filter((size) => size !== typical).length;
    const sentIds = new Set(sent.map(({ tp }) => tp.traceId));
    const foreign = [...groups.keys()].filter((id) => !sentIds.has(id)).length;
    // within a trace, every line must name the request's own key: a line with
    // trace A and key B is a line that changed requests half-way
    const keyOf = new Map(sent.map(({ tp, key }) => [tp.traceId, key]));
    const mixed = window.filter((json) => keyOf.has(json.trace_id) && json.idempotencyKey !== keyOf.get(json.trace_id)).length;

    console.log(`burst: ${BURST} requests (${replies.map((r) => r.status).join(' ')}), ${window.length} lines in ${groups.size} trace groups of sizes ${sizes.join(',')}`);

    // 3. secrets on the way in
    const bearerMarker = `bearer-marker-${randomBytes(12).toString('hex')}`;
    const passwordMarker = `password-marker-${randomBytes(12).toString('hex')}`;
    const secret = traceparent();
    const secretReply = await api.call('POST', '/auth/login', {
      body: { email: buyer.email, password: passwordMarker },
      headers: { Authorization: `Bearer ${bearerMarker}`, traceparent: secret.header },
    });
    await api.waitForLines(completed(secret.traceId), 1);
    const secretLines = api.lines.filter((line) => line.json?.trace_id === secret.traceId && line.json.msg === 'request completed');
    const leaked = api.lines.filter((line) => line.text.includes(bearerMarker) || line.text.includes(passwordMarker)).length;
    const redacted =
      secretLines.length > 0 &&
      secretLines[0].json.req?.headers?.authorization === '[Redacted]' &&
      secretLines[0].json.req?.body?.password === '[Redacted]';

    console.log(`secret: login ${secretReply.status}, request lines ${secretLines.length}, lines with a marker ${leaked}`);

    // every line the process wrote, stdout and stderr, from its first to now
    const nonJson = api.lines.filter((line) => line.json === null);
    for (const line of nonJson.slice(0, 5)) console.log(`  not JSON (${line.stream}): ${line.text.slice(0, 160)}`);
    console.log('');

    invariants.check('single checkout created', singleReply.status === 201, `${singleReply.status}`);
    invariants.check('every line is a JSON object', nonJson.length === 0, `${nonJson.length} of ${api.lines.length} are not`);
    invariants.check('the request crosses ≥ 3 layers', layers.size >= 3, [...layers].join(', '));
    invariants.check('one trace_id across all its lines', singleTraces.size === 1, `${singleTraces.size}`);
    invariants.check('that trace_id is the one from traceparent', singleTraces.size === 1 && singleTraces.has(single.traceId), [...singleTraces].join(','));
    invariants.check('user and tenant from the context on every line', withUser === singleLines.length, `${withUser}/${singleLines.length}`);
    invariants.check(`burst of ${BURST} all created`, replies.every((r) => r.status === 201), replies.map((r) => r.status).join(' '));
    invariants.check('one trace group per request', groups.size === BURST && foreign === 0, `${groups.size} groups, ${foreign} not sent by the demo`);
    invariants.check('all groups the same size', uneven === 0, `sizes ${sizes.join(',')}`);
    invariants.check('no line carries another request’s key', mixed === 0, `${mixed}`);
    invariants.check('the login request is logged', secretLines.length === 1, `${secretLines.length}`);
    invariants.check('…with header and password redacted', redacted, redacted ? '[Redacted]' : 'not redacted');
    invariants.check('neither marker anywhere in the output', leaked === 0, `${leaked} lines`);
    console.log('');

    report({
      'non-json-lines': nonJson.length,
      'lines-total': api.lines.length,
      layers: layers.size,
      'distinct-trace-ids': singleTraces.size,
      'trace-id-matches-header': singleTraces.size === 1 && singleTraces.has(single.traceId) ? 1 : 0,
      burst: BURST,
      'burst-trace-ids': groups.size,
      'burst-uneven': uneven,
      'burst-mixed-keys': mixed,
      'secret-req-logged': secretLines.length > 0 ? 1 : 0,
      'secret-in-logs': leaked,
    });

    if (invariants.broken > 0) console.error(api.dump());
    return invariants.broken === 0 ? 0 : 1;
  } finally {
    await api.stop();
  }
});

function mode(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}
