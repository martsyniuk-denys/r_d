// demo:metrics — RED counts what happened, and the label set is bounded.
//
//   1. scrape /metrics, send SENT checkouts (fast ones, slow ones that hold the
//      database for 1.2 s, and failing ones that Postgres answers with an error →
//      500), scrape again. The counter grew by exactly what was sent, the 5xx
//      series by exactly the failures, and no request fell past the last finite
//      bucket of the histogram
//   2. the cardinality: one GET /orders/<id> to warm the route, count the series
//      of the counter, then a hundred GETs with a hundred different ids, count
//      again. route is the template /orders/:orderId, so the count does not move
//
// Every number is a difference of two scrapes or a count of replies; none is typed in.

import { DURATION_TOP, Invariants, ObservedApi, idempotencyKey, login, prepare, report, required, runDemo, sum } from './lib/observed-api.mjs';

const FAST = 48;
const SLOW = 4;
const FAILING = 8;
const IDS = 100;
const CONCURRENCY = 6;

const ROUTE = { method: 'POST', route: '/orders' };
const isRoute = (labels) => labels.method === ROUTE.method && labels.route === ROUTE.route;

runDemo(async () => {
  const invariants = new Invariants();
  const prometheus = required('PROMETHEUS_URL');
  const { buyer, productId } = await prepare('demo-metrics');
  const api = await ObservedApi.start();

  try {
    const token = await login(api, buyer);
    const checkout = (fault) =>
      api.call('POST', '/orders', {
        token,
        body: { items: [{ product_id: productId, qty: 1 }] },
        headers: { 'Idempotency-Key': idempotencyKey(), ...(fault === undefined ? {} : { 'X-Fault': fault }) },
      });

    // warm the route, so the first scrape already has its series
    await checkout();

    // Prometheus computes rate() from the difference between its own scrapes. A
    // load sent before its first scrape of this new process would sit in the
    // starting value of the series and never show up on the dashboard.
    const started = sum(await api.scrape(), 'process_start_time_seconds');
    const scraped = await prometheusScraped(prometheus, started);
    console.log(`prometheus (${prometheus}): ${scraped ?? 'not reachable'}`);

    // 1. RED over SENT requests
    const before = await api.scrape();
    const plan = [...Array(FAST).fill(undefined), ...Array(SLOW).fill('slow'), ...Array(FAILING).fill('error')];
    const replies = await inBatches(plan, CONCURRENCY, checkout);
    const after = await api.scrape();

    const sentFail = replies.filter((r) => r.status >= 500).length;
    const sentOk = replies.length - sentFail;
    const counterDelta = sum(after, 'http_requests_total', isRoute) - sum(before, 'http_requests_total', isRoute);
    const is5xx = (labels) => isRoute(labels) && /^5\d\d$/.test(labels.status);
    const errorsDelta = sum(after, 'http_requests_total', is5xx) - sum(before, 'http_requests_total', is5xx);

    const top = Math.max(
      ...after.filter((s) => s.name === 'http_request_duration_seconds_bucket' && s.labels.le !== '+Inf').map((s) => Number(s.labels.le)),
    );
    const count = sum(after, 'http_request_duration_seconds_count', isRoute);
    const inTop = sum(after, 'http_request_duration_seconds_bucket', (l) => isRoute(l) && Number(l.le) === top);
    const aboveTop = count - inTop;
    const slowest = Math.max(...replies.map((r) => r.ms));

    console.log(`sent ${replies.length}: ${replies.map((r) => r.status).join(' ')}`);
    console.log(`slowest reply ${Math.round(slowest)} ms; top finite bucket le="${top}"`);

    // 2. cardinality
    const series = (samples) => samples.filter((s) => s.name === 'http_requests_total').length;
    await api.call('GET', '/orders/o_warmup', { token });
    const seriesBefore = series(await api.scrape());
    const lookups = await inBatches(
      Array.from({ length: IDS }, (_, i) => `o_${100000 + i}`),
      CONCURRENCY * 2,
      (id) => api.call('GET', `/orders/${id}`, { token }),
    );
    const afterIds = await api.scrape();
    const seriesAfter = series(afterIds);
    const idRoutes = new Set(afterIds.filter((s) => s.name === 'http_requests_total' && s.labels.method === 'GET').map((s) => s.labels.route));

    console.log(`${IDS} ids → ${lookups.filter((r) => r.status === 404).length} × 404; ${idRoutes.size} GET routes in the counter`);

    // 3. what Prometheus made of it (informational)
    const seen = await prometheusSees(prometheus, IDS + 1);
    console.log(`prometheus: ${seen ?? 'not reachable'}`);
    console.log('');

    invariants.check(`${plan.length} sent`, replies.length === plan.length, `${replies.length}`);
    invariants.check('fast and slow ones created, failing ones 500', sentOk === FAST + SLOW && sentFail === FAILING, `ok=${sentOk} fail=${sentFail}`);
    invariants.check('counter grew by what was sent', counterDelta === sentOk + sentFail, `delta ${counterDelta}`);
    invariants.check('5xx series grew by the failures', errorsDelta === sentFail, `delta ${errorsDelta}`);
    invariants.check('the histogram top is the one in the code', top === DURATION_TOP, `${top} vs ${DURATION_TOP}`);
    invariants.check('nothing above the top finite bucket', aboveTop === 0, `${aboveTop}`);
    invariants.check('the slowest reply is under the top bucket', slowest / 1000 < top, `${Math.round(slowest)} ms < ${top} s`);
    invariants.check(`${IDS} different ids add no series`, seriesAfter === seriesBefore, `${seriesBefore} → ${seriesAfter}`);
    invariants.check('the ids were answered 404 under one route template', lookups.every((r) => r.status === 404) && idRoutes.has('/orders/:orderId'), `${idRoutes.size} GET routes: ${[...idRoutes].slice(0, 4).join(', ')}${idRoutes.size > 4 ? ', …' : ''}`);
    console.log('');

    report({
      'sent-ok': sentOk,
      'sent-fail': sentFail,
      'counter-delta': counterDelta,
      'errors-delta': errorsDelta,
      'top-bucket-seconds': top,
      'slowest-ms': Math.round(slowest),
      'above-top-bucket': aboveTop,
      ids: IDS,
      'series-before': seriesBefore,
      'series-after': seriesAfter,
    });

    if (invariants.broken > 0) console.error(api.dump());
    return invariants.broken === 0 ? 0 : 1;
  } finally {
    await api.stop();
  }
});

async function inBatches(items, size, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += size) {
    results.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return results;
}

// Informational: waits (up to 10 s) until Prometheus has scraped the process this
// demo started — its process_start_time_seconds is the one /metrics reports.
async function prometheusScraped(url, started) {
  const query = encodeURIComponent('max(process_start_time_seconds{job="marketplace-api"})');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/v1/query?query=${query}`, { signal: AbortSignal.timeout(3000) });
      const value = Number((await response.json())?.data?.result?.[0]?.value?.[1] ?? 0);
      if (value === started) return 'scraped this process before the load';
    } catch {
      return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return 'has not scraped this process yet';
}

// Informational: waits (up to 15 s) until a Prometheus scrape has caught this
// run's last requests, so the dashboard has the whole run before the process
// that served it goes away. Prometheus scrapes OBS_APP_PORT every 5 s.
async function prometheusSees(url, lookups) {
  const query = encodeURIComponent('sum(http_requests_total{job="marketplace-api", route="/orders/:orderId"})');
  const deadline = Date.now() + 15_000;
  let seen = 0;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/v1/query?query=${query}`, { signal: AbortSignal.timeout(3000) });
      seen = Number((await response.json())?.data?.result?.[0]?.value?.[1] ?? 0);
      if (seen >= lookups) return `scraped this run (${seen} GET /orders/:orderId)`;
    } catch {
      return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return `not scraped yet (${seen} of ${lookups} GET /orders/:orderId)`;
}
