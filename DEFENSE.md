# Defense: run sheet and answers

What to show in ten minutes, in what order, and what to answer. Every expected output below
was produced by the command next to it; nothing is written from memory. The full evidence is
in [README → Grading, block by block](README.md#grading-block-by-block).

## Before the call (5 minutes)

```bash
docker compose down                                   # another copy of the stack holds the ports
docker compose --profile obs up -d --wait             # app + Prometheus, Jaeger, Grafana
curl -s localhost:3000/readyz                         # {"status":"ready","checks":{"database":"up","broker":"up"}}
docker compose run --rm demo demo/contour.mjs >/dev/null && echo warm   # first run warms the pools
```

Open in the browser beforehand: Grafana `http://127.0.0.1:22903/d/marketplace-red`
(`admin` / `secrets/grafana_admin_password.example`), Jaeger `http://127.0.0.1:22904`,
the green CI run https://github.com/martsyniuk-denys/r_d/actions/runs/45259552063.

If the laptop cannot run Docker on the day, everything below is also recorded:
`evidence/acceptance.txt` (a fresh clone, step by step) and the CI run's `deploy-evidence`.

## The ten minutes

| # | Time | Say | Run | Expect |
| --- | --- | --- | --- | --- |
| 1 | 1 min | A marketplace. The order is the main entity; its life is pending → confirmed → paid → shipped, each step by a different actor. | the mermaid sequence in README → *The main contour* | — |
| 2 | 2 min | The whole contour through the public API, and the exit code is the verdict. | `docker compose run --rm demo demo/contour.mjs` | `created=1 replayed=1 confirmed=1 paid=1 final=shipped history=4`, exit 0 |
| 3 | 1 min | The webhook: forged signature, wrong amount, a duplicate — each has exactly one outcome. | `docker compose run --rm demo demo/webhook.mjs` | `accepted=1 rejected-signature=1 amount-mismatch=1 duplicates=1` |
| 4 | 1.5 min | One trace across three processes, although the relay sends the event later. | `docker compose run --rm demo demo/contour-trace.mjs`, then the trace in Jaeger | 5 hops, 0 orphan spans |
| 5 | 1 min | RED metrics and the transitions counter on a dashboard that lives in git. | Grafana, row *Main contour* | request rate, errors, p95; `order_status_transitions_total` |
| 6 | 1.5 min | Readiness goes red before the process stops, so no request lands on a closing API. | `docker compose kill -s SIGTERM api`; `curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/readyz` and `/healthz` within 5 s; `docker compose up -d --wait api` | `/readyz` 503, `/healthz` 200, container exits 0 |
| 7 | 1 min | The same image, the same contour in Kubernetes, deployed by CI by digest. | the CI run, job *deploy*, artifact `deploy-evidence` | `contour-final=shipped`, `rollout-failed=0`, `secret-in-manifest=0` |
| 8 | 1 min | Every gate can say no. | `npm run demo:gates` | `<gate>-ok=0` and `<gate>-broken` ≠ 0 for each (arch prints `arch-broken=2`: two planted violations) |

If time is short, keep 2, 3 and 6: the contour, the money, and the shutdown.

## Questions to expect, by block

### 11.1 Design and architecture

- **Where is the business logic?** In services and plain functions, not in controllers:
  `src/orders/place-order.ts` (checkout), `src/orders/lifecycle.ts` (the transition table),
  `src/payments/apply-payment.ts`. `npm run gate:arch` fails the build if a controller imports
  a repository (`controllers-stay-thin` in `.dependency-cruiser.cjs`).
- **What happens with a broken config?** The process validates the whole environment with one
  zod schema before Nest is imported, names every bad variable, never echoes a secret, exits 1
  (`src/config/env.schema.ts`, `src/main.ts`).
- **Your biggest trade-off?** The transactional outbox. The order and its event are one fact
  in one `COMMIT`; the price is one relay poll of latency and at-least-once delivery, which is
  why every consumer is idempotent.

### 11.2 Contour and correctness

- **Why no oversell under 50 parallel checkouts?** Each line is one statement:
  `UPDATE products SET stock = stock - n WHERE id = $1 AND stock >= n`. Zero rows updated means
  a shortage, and the whole transaction rolls back. Lines go in product-id order, so two carts
  cannot deadlock. Shown by `npm run demo:race` and the e2e `sells exactly the stock`.
- **Why not `SELECT … FOR UPDATE`?** It works, but it holds the lock across a round trip; the
  conditional `UPDATE` checks and writes in one step.
- **What makes a repeat safe?** The `Idempotency-Key` header, scoped to route and user, is stored
  in Postgres with a hash of the request in the same transaction as the order. The same key with
  another cart gets 422; the same key with the same cart gets the original order and
  `Idempotency-Replay: true`. Payments are deduplicated by the provider's `event_id` (`UNIQUE`).
- **Why the key in Postgres and not Redis?** It must commit or roll back together with the order
  it protects. A Redis key can outlive a rolled-back order.

### 11.3 Data

- **Show a revert.** `npm run migrate:revert && npm run migrate`; both exit 0.
- **RTO/RPO?** RTO 15 min committed, 1.7 s measured by the restore drill: `MATCH` when the
  restored `order_items` give the same row count and money sum as the checksum written at backup
  time. RPO 24 h, a nightly `pg_dump` (`RESTORE-DRILL.md`). Only `order_items` is checksummed —
  say so if asked.
- **Why PgBouncer in transaction mode, and what does it cost?** Postgres pays for every
  connection; three processes with pools add up. The cost is session state: no `LISTEN/NOTIFY`,
  which is why realtime goes through RabbitMQ.

### 11.4 Security

- **How does logout kill an access token that is still valid?** Logout revokes the refresh
  family and puts the access token's `jti` on a denylist until it expires.
- **A stolen refresh token?** Rotation on every refresh; reuse of an old one revokes the whole
  family (`npm run demo:reuse`).
- **Why ES256?** The API that verifies never holds a key that can sign, and the algorithm comes
  from an allowlist, never from the token header.
- **401 or 403?** 401 when no valid identity, 403 when the identity is known but not allowed:
  the role by a guard, ownership in the service (another buyer's order → 403).
- **Webhook.** HMAC-SHA256 over the raw body, compared with `timingSafeEqual`; the amount must
  equal the total frozen at checkout, else 422 and a journal row.
- **Where are the secrets?** Files (`NAME_FILE`): compose generates them into a volume on the
  first `up`; in kind they come from the store as one Secret mounted as files. Not in git, not in
  image layers (`npm run demo:image`), not in `docker inspect`.

### 11.5 Asynchrony

- **What if the process dies between `COMMIT` and publish?** Nothing is lost: the event is a row
  of the same transaction; the relay publishes it later (`npm run demo:crash-write`,
  `demo:crash-relay`).
- **And a duplicate delivery?** The consumer records the message id in `processed_messages` in
  the same transaction as its effect; the second delivery does nothing (`npm run demo:duplicate`).
- **Why `prefetch = 32`?** One message is one short transaction on a pool of 10. `prefetch = 1`
  idles the pool across every round trip; 32 × processing time stays far below RabbitMQ's
  consumer timeout.
- **A poison message?** A delivery limit and a DLQ; the reason is read from `x-death`
  (`npm run demo:dlq`).

### 11.6 Delivery

- **From a clean clone?** `docker compose up -d --wait` and nothing else: `scripts/acceptance.sh`
  did exactly that, `evidence/acceptance.txt`, 0 failed steps.
- **The image?** Four stages, distroless runtime, no shell, uid 65532, the npm token a BuildKit
  secret, a Trivy threshold that fails the build.
- **Kubernetes?** Pulumi deploys Postgres, RabbitMQ, a migrate Job, the API, the relay and the
  consumer to kind; CI deploys the built digest, runs the contour against it, then a rollout under
  load with `failed=0`.

### 11.7 Operations and quality

- **Liveness vs readiness?** `/healthz` only says the event loop turns; `/readyz` checks Postgres
  and goes 503 on SIGTERM, so the pod leaves the balancer while it drains.
- **One `trace_id`?** It is in every log line of the API, the relay and the consumer for one
  order; the relay stores the trace context in the outbox row and sends `traceparent` in AMQP
  headers.
- **Tests?** Unit for the business rules without HTTP, integration against a real Postgres (run
  twice, a two-connection race included), e2e of the contour; a mutation check broke the status
  guard and the amount check, and 5 tests went red.

### 11.8 The three questions the ТЗ gives as examples

- **Why is the ack after the effect?** An ack tells RabbitMQ to forget the message. Acked before
  the transaction commits, a crash in between loses the work for good. Acked after, a crash means
  one more delivery, which the inbox (`processed_messages`, same transaction as the effect)
  turns into a no-op. At-least-once plus an idempotent effect gives exactly one effect; the
  other order gives at-most-once (`src/messaging/order-placed.consumer.ts`, `demo:crash-relay`).
- **Why can't publish and `UPDATE published_at` swap places?** Marked first and then the
  process dies before the publish: the row says "sent", nothing was sent, and nothing will ever
  retry it — the event is lost. Published first, waited for the broker's confirm, then marked: a
  crash in between publishes the row once more, and the consumer's dedup absorbs it
  (`src/outbox/relay.ts`: SELECT … SKIP LOCKED → publish + confirm → UPDATE).
- **What breaks with realtime on two instances?** A buyer's socket sits on one instance, the
  status change can happen on another (or in the consumer). An in-memory emitter would only reach
  sockets of the process that changed it. Here each API instance binds its own exclusive queue to
  `order.status_changed`, so every instance hears every change and pushes it to the owner's
  sockets it holds; SSE replays from `order_status_history` by `Last-Event-ID`, so a reconnect to
  the other instance loses nothing (`src/realtime/order-status.feed.ts`).

### Walkthrough: the feature the lecturer picks → the command

Every row of README → *Block → path* is "yes". The command for each, with what it prints:

| Feature | Command | Prints |
| --- | --- | --- |
| 50 concurrent, no oversell | `npm run demo:race` | `no oversell`, balances match, exit 0 |
| Idempotent repeat | `npm run demo:outbox` | `outbox=1 published=1 deliveries=1 effect=1` |
| N+1 | `npm run demo:nplus1` | `33 queries` naive → `1 query` with relations |
| Restore drill | `bash scripts/with-secrets.sh dev bash scripts/restore-drill.sh` | `MATCH`, RTO 3.3 s |
| Cache, single-flight | `npm run demo:cache` | `concurrent=50 db-calls=1` |
| Session survives a restart | `npm run demo:session` | `survived-restart=1` |
| Files, closed bucket, CDN | `npm run demo:upload`, `demo:cdn` | `put-offline=200`, `direct=403 cache-hit=1` |
| Logout, refresh reuse | `npm run demo:auth`, `demo:reuse` | `after-logout=401`, `r1-reuse=401 r2-after-reuse=401 reuse-logged=1` |
| 401 vs 403 | `npm run demo:rbac` | `anon=401 own=200 foreign=403 role-denied=403 tampered=401` |
| Rate limit | `npm run demo:ratelimit` | `status=429 retry-after=1`, two instances, one shared window |
| Secrets dev ≠ prod | `node scripts/jwt-keys.mjs fingerprint dev` / `prod` | two different kids and fingerprints |
| Outbox crash | `npm run demo:crash-write`, `demo:crash-relay` | `outbox=0 deliveries=0`; `acked=2 effect=1` |
| Prefetch, DLQ, workers | `npm run demo:publish`, `demo:dlq`, `demo:workers` | `prefetch=32`; `work=0 dlq=1`; every job once |
| Realtime owner only | `npm run demo:realtime`, `:same-room` | `A_RECEIVED=1 B_RECEIVED=0`; same room `B_RECEIVED=1` |
| Image | `npm run demo:image`; `SCAN_MAX=-1 npm run scan` | `stages=4 shell-inside=0 runtime-uid=65532 token-in-*=0`; `gate=fail` exit 1 |
| Rollout | `npm run demo:rollout` (kind up) | `failed=0` |
| Logs | `npm run demo:logs` | `layers=3 distinct-trace-ids=1 burst-uneven=0 secret-in-logs=0` |
| Metrics, trace | `npm run demo:metrics`, `demo:trace` | `errors-delta=8`; `trace-matches-log=1` |
| Tests | `npm run test:integration` twice, `test:e2e`, `test:unit` | 26, 26, 16, 20 passed |

The outbox and queue demos run their own relay and consumer: `docker compose stop relay consumer`
first, `docker compose start relay consumer` after (README → *Running from source*).

## Weak points, and the honest answer

| If asked | Answer |
| --- | --- |
| Is Redis in the contour? | No: cache-aside, sessions and the rate limit run in their own processes, which is the evidence the ТЗ names (`demo:cache`, `demo:session`, `demo:ratelimit`). The Nest API of the contour does not use Redis. |
| Is `POST /orders` rate-limited? | Not in the Nest API: the shared-store limiter (`src/ratelimit/sliding-window.ts`) guards the edge process. |
| Products and files idempotency? | Still the in-memory one; the orders contour uses Postgres. |
| The contract gate is red on the PR. | On purpose: the status enum changed. The PR carries `breaking-approved`; the gate still prints `gate=fail`, the label only stops it from blocking. |
| Is the payment provider real? | Simulated: the demos sign like a provider would. |
| Is the kind stand production? | One replica of Postgres and RabbitMQ on local-path volumes — a stand. No pgbouncer, Redis or object storage there. |
