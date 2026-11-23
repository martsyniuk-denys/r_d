# Marketplace API — coursework (Node.js PRO)

A marketplace backend in NestJS on Postgres, built homework by homework and finished
as the coursework: one order goes from the buyer's `POST /orders` through a
transactional outbox, RabbitMQ and a background consumer to a signed payment webhook,
and every step is read back by a separate request. One `docker compose up -d --wait`
brings all of it up from a clean clone.

The coursework is the part of this file down to [the appendix](#appendix-the-homeworks-one-by-one).
The appendix is the record of every homework, and the grading table below points into it
where an older homework is the evidence.

- [Quick start](#quick-start) — clone, one command, three demos
- [The main contour](#the-main-contour) — the sequence, by hand with curl
- [Architecture](#architecture) — processes, layers, where the code is
- [Domain note (ДЗ0)](#domain-note-дз0) — the domain, trade-offs, decision log
- [Grading, block by block](#grading-block-by-block) — 11.1–11.7: where it is, how to check it
- [Environment variables](#environment-variables)
- [Security: OWASP Top 10:2025](#security-owasp-top-102025)
- [Secrets and their rotation](#secrets-and-their-rotation)
- [Kubernetes: the full contour](#kubernetes-the-full-contour) — API, workers, Postgres, RabbitMQ in kind via Pulumi
- [Honest boundaries](#honest-boundaries) — what is not done, and where the edges are
- [Running from source](#running-from-source) and [Commands](#commands)

## Quick start

Needs Docker with Compose v2 and nothing else: no Node on the host, no `.env`, no npm
token, no access to the secret store.

```bash
git clone https://github.com/martsyniuk-denys/r_d && cd r_d && git checkout feature/homework_31
docker compose up -d --wait                       # build, keys, migrate + seed, api/relay/consumer; returns when /readyz is 200
docker compose run --rm demo demo/contour.mjs     # the whole contour, exit 0
docker compose run --rm demo demo/webhook.mjs     # signature, amount, duplicate: each = 1, exit 0
```

`up --wait` builds `docker/Dockerfile` (the production image) once, then runs it in five
roles, in order: `keys` generates the application's own secrets into a volume (once, kept
on later runs), `migrate` applies the TypeORM migrations and the idempotent seed, and
`api`, `relay` and `consumer` start after it. The API's healthcheck is `/readyz`, so the
command returns when the API can actually serve.

The contour demo prints each step and a summary, and its exit code is the verdict:

```
contour against http://api:3000

  ok    create: HTTP 201, o_92 pending, total 1029700
  ok    idempotent replay: same key → o_92, Idempotency-Replay: true
  ok    access and validation: other buyer 403, no token 401, qty 0 → 400 application/problem+json; charset=utf-8
  ok    background: consumer confirmed it: status confirmed
  ok    payment webhook: HTTP 200, verdict applied
  ok    operator ships: admin → 200 shipped; buyer → 403
  ok    final read: GET /orders/o_92 → shipped
  ok    history: pending(checkout) → confirmed(fulfilment) → paid(payment-webhook) → shipped(admin:131)

order=o_92
created=1
replayed=1
confirmed=1
paid=1
final=shipped
history=4
```

```
webhook against http://api:3000

  ok    forged signature: HTTP 401, order still pending
  ok    amount mismatch: HTTP 422 https://marketplace.example/problems/amount-mismatch, order still confirmed
  ok    accepted: HTTP 200, applied → paid
  ok    duplicate: HTTP 200, verdict duplicate, 'paid' in history 1×

accepted=1
rejected-signature=1
amount-mismatch=1
duplicates=1
```

All of this section, the curl walk-through below and the checks of the grading table were
run from a fresh clone by `scripts/acceptance.sh`; its output, with every command and exit
code, is [`evidence/acceptance.txt`](evidence/acceptance.txt).

**Observability** is a profile of the same file: Prometheus, Jaeger and Grafana with the
dashboard provisioned from `observability/grafana/dashboards/marketplace-red.json`.

```bash
docker compose --profile obs up -d --wait
docker compose run --rm demo demo/contour-trace.mjs   # one trace across api → relay → consumer, read back from Jaeger
```

```
checkout: trace f812f14e6a7d581a634d57d6303c4b58, 32 spans from marketplace-api, marketplace-consumer, marketplace-relay
    ok   marketplace-api       POST /orders                         ← caller (traceparent header)
    ok   marketplace-relay     order.placed publish                 ← marketplace-api orders.place
    ok   marketplace-consumer  fulfilment.order-placed process      ← marketplace-relay order.placed publish
    ok   marketplace-relay     order.status_changed publish         ← marketplace-consumer fulfilment.order-placed process
    ok   marketplace-api       api.realtime process                 ← marketplace-relay order.status_changed publish
  ok    checkout: every hop in one trace: 5 hops found
  ok    checkout: no orphan spans: 0 spans whose parent is not in the trace
```

| What | Where | Login |
| --- | --- | --- |
| API | `http://localhost:3000` (spec: `openapi/openapi.yaml`) | seed users below |
| Grafana, dashboard | `http://127.0.0.1:22903/d/marketplace-red` | `admin` / `secrets/grafana_admin_password.example` |
| Jaeger | `http://127.0.0.1:22904` | — |
| Prometheus | `http://127.0.0.1:22901` | — |
| RabbitMQ management | `http://localhost:15672` | `marketplace` / `marketplace_dev_password` |

Seed users, all with the password `marketplace-dev-password`: buyers
`olena.kovalenko@example.com` and `andrii.shevchenko@example.com`, the operator
`ops.admin@example.com` (role `admin`), seller `leader.shoes@example.com`.

**Before you run it.** The infrastructure containers have fixed names
(`marketplace-postgres` and so on) and fixed host ports: 3000, 5672, 15672, 9292, 55432,
56432, 56379, 56380, 59000, and with `obs` 22901, 22903, 22904. If another copy of this
stack is running, stop it first (`docker compose down` in that directory). The `obs`
profile and the standalone stand (`npm run obs:up`) use the same ports, so run one of
them, not both. If an `up` failed half-way on a taken port, the containers it left behind
may have no network: `docker compose --profile obs up -d --wait --force-recreate`.

**Restart and teardown.** `docker compose down && docker compose up -d --wait` keeps the
data (named volumes) and the generated keys, so a token issued before the restart still
works after it. `docker compose --profile obs --profile demo down -v` removes everything.
The image `marketplace-api:compose` is built only when it is missing (it is never pulled:
it exists in no registry), so after a `git pull` or a change in the code, rebuild it with
`docker compose up -d --wait --build`.

## The main contour

An order is placed by a buyer, confirmed by a background consumer, paid by a signed
provider webhook and read back by separate requests. The buyer hears about every status
change over SSE or WebSocket.

```mermaid
sequenceDiagram
    autonumber
    actor Buyer
    participant API as API (Nest)
    participant DB as Postgres (via PgBouncer)
    participant Relay
    participant MQ as RabbitMQ
    participant Consumer
    actor Provider as Payment provider

    Buyer->>API: POST /orders + Idempotency-Key
    API->>DB: BEGIN, reserve stock per line, order 'pending',<br/>payment intent (frozen amount), outbox order.placed, COMMIT
    API-->>Buyer: 201 {status: pending}
    Relay->>DB: SELECT … FROM outbox FOR UPDATE SKIP LOCKED
    Relay->>MQ: publish order.placed (traceparent header), wait for confirm
    Relay->>DB: UPDATE outbox SET published_at
    MQ->>Consumer: deliver (prefetch 32, manual ack)
    Consumer->>DB: BEGIN, inbox mark, fulfilment, pending→confirmed,<br/>history, outbox order.status_changed, COMMIT
    Consumer->>MQ: ack
    Relay->>MQ: publish order.status_changed
    MQ->>API: realtime feed → SSE/WS event to the owner only
    Provider->>API: POST /payments/webhook, X-Signature: sha256=HMAC(raw body)
    API->>DB: BEGIN, payment_events (UNIQUE provider event id),<br/>amount == frozen? confirmed→paid, history, outbox, COMMIT
    API-->>Provider: 200 {verdict: applied}
    Buyer->>API: GET /orders/{id}, GET /orders/{id}/history
    API-->>Buyer: paid, and every step with who made it
```

The lifecycle is one table in `src/orders/lifecycle.ts`, enforced by the SQL rather than
only by the map: a transition is `UPDATE … WHERE status = ANY(<allowed sources>)`, so two
concurrent transitions out of one status cannot both win. Every change writes the order
row, an `order_status_history` row and an `order.status_changed` outbox row in one
transaction.

```
pending ──consumer──► confirmed ──webhook──► paid ──admin──► shipped
   │  └──────────────webhook─────────────────►┘│                │
   └──────► cancelled ◄──┘                    └──► refunded ◄──┘
```

### By hand, with curl

Against the compose stack from [Quick start](#quick-start). Needs `curl`, `node` (only to
pull a field out of JSON) and `openssl` (to sign the webhook like the provider does).

```bash
B=http://localhost:3000
TOKEN=$(curl -s $B/auth/login -H 'content-type: application/json' \
  -d '{"email":"olena.kovalenko@example.com","password":"marketplace-dev-password"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token')

# 1. checkout — Idempotency-Key is required by the contract
CREATED=$(curl -s $B/orders -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H "idempotency-key: $(uuidgen)" -d '{"items":[{"product_id":"p_1","qty":1}]}')
echo "$CREATED"
# {"id":"o_13","status":"pending","buyer_id":"5","currency":"UAH","items":[{"product_id":"p_1","qty":1,"unit_price_cents":249900}],"total_cents":249900,…}
ORDER=$(echo "$CREATED" | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
TOTAL=$(echo "$CREATED" | node -pe 'JSON.parse(require("fs").readFileSync(0)).total_cents')

# 2. a separate read, a moment later — the consumer has been there
sleep 1
curl -s $B/orders/$ORDER -H "authorization: Bearer $TOKEN"; echo
# {"id":"o_13","status":"confirmed",…}

# 3. the provider's webhook: HMAC-SHA256 over the exact raw body with the key from the keys volume
SECRET=$(docker compose run --rm -T --no-deps --entrypoint cat demo /keys/PAYMENT_WEBHOOK_SECRET)
BODY="{\"event_id\":\"evt_$ORDER\",\"order_id\":\"$ORDER\",\"amount_cents\":$TOTAL,\"currency\":\"UAH\",\"outcome\":\"succeeded\"}"
SIG=sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $NF}')
curl -s $B/payments/webhook -H 'content-type: application/json' -H "x-signature: $SIG" -d "$BODY"; echo
# {"event_id":"evt_o_13","order_id":"o_13","verdict":"applied","order_status":"paid"}
curl -s $B/payments/webhook -H 'content-type: application/json' -H "x-signature: $SIG" -d "$BODY"; echo
# {"event_id":"evt_o_13","order_id":"o_13","verdict":"duplicate","order_status":"paid"}

# 4. the final state, and how it got there
curl -s $B/orders/$ORDER/history -H "authorization: Bearer $TOKEN"; echo
# {"items":[{"id":7,"status":"pending","previous_status":null,"changed_by":"checkout",…},
#           {"id":8,"status":"confirmed","previous_status":"pending","changed_by":"fulfilment",…},
#           {"id":9,"status":"paid","previous_status":"confirmed","changed_by":"payment-webhook",…}]}

# 5. the edge: no Idempotency-Key → 400 problem+json, before a controller runs
curl -s $B/orders -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"items":[{"product_id":"p_1","qty":1}]}'; echo
# {"type":"https://marketplace.example/problems/validation-error","title":"Bad Request","status":400,
#  "detail":"request/headers must have required property 'idempotency-key'","instance":"/orders"}

# 6. the owner's SSE stream; Last-Event-ID: 0 replays every change from the history, then it
#    stays open for live ones (-m 3 closes it after 3 s; drop -m to keep listening)
curl -sN -m 3 $B/orders/$ORDER/events -H "authorization: Bearer $TOKEN" -H 'last-event-id: 0'
# id: 7
# event: order.status
# data: {"id":7,"order_id":"o_13","status":"pending","previous_status":null,…}
# …
```

| Method and path | Who | What |
| --- | --- | --- |
| `POST /orders` | buyer | checkout; `Idempotency-Key` required; 201, 409 on shortage (all lines roll back) |
| `GET /orders?cursor=` | buyer: own, admin: all | cursor pagination |
| `GET /orders/{id}` | owner or admin | 403 for another buyer, 404 for none |
| `GET /orders/{id}/history` | owner or admin | every transition, who made it |
| `GET /orders/{id}/events` | owner or admin | SSE, `Last-Event-ID` replays from the history |
| `PATCH /orders/{id}/status` | admin (`RolesGuard`) | along the lifecycle only; 409 otherwise |
| `POST /payments/webhook` | the provider (signature) | 401 bad signature, 422 amount mismatch, 200 duplicate with no effect |
| `GET /healthz`, `GET /readyz` | probes | liveness; readiness (Postgres, 503 on SIGTERM) |
| `GET /metrics` | Prometheus | RED + contour metrics |

The full contract, with every schema and error, is `openapi/openapi.yaml`; the
validator checks requests and responses against it at runtime.

## Architecture

```mermaid
flowchart LR
    client([Buyer / admin]) -->|HTTP, WS, SSE| api
    provider([Payment provider]) -->|signed webhook| api

    subgraph app[One image, three processes]
        api[api<br/>dist/main.js<br/>controller → service → repository]
        relay[relay<br/>dist/relay.js]
        consumer[consumer<br/>dist/consumer.js]
    end

    api -->|one COMMIT: order + outbox| pgb[(PgBouncer<br/>transaction mode)]
    relay -->|SKIP LOCKED| pgb
    consumer -->|one tx per message| pgb
    pgb --> pg[(Postgres 16)]

    relay -->|publish + confirm| mq{{RabbitMQ}}
    mq -->|order.placed| consumer
    mq -->|order.status_changed| api
    mq -. delivery limit .-> dlq[(DLQ)]

    api -->|presigned URLs| s3[(RustFS / S3, private)]

    api & relay & consumer -. OTLP .-> jaeger[Jaeger]
    prom[Prometheus] -. scrape /metrics .-> api & relay & consumer
    grafana[Grafana] --> prom & jaeger
```

The API is layered, and the layers are enforced, not only drawn: `npm run gate:arch`
(dependency-cruiser, `.dependency-cruiser.cjs`) fails the build when a controller imports a
repository, the pool, the outbox, the broker or a checkout transaction
(`controllers-stay-thin`), or when the catalog reaches into the order flow
(`catalog-does-not-know-orders`). `test/gates/arch` holds one planted violation of each, and
`npm run demo:gates` shows the gate saying no to them. Every log line carries `layer`
(`http`, `orders.controller`, `orders.service`, …), so the layers are visible at run time too.

| Layer | Where | What it may do |
| --- | --- | --- |
| edge | `src/bootstrap.ts`, `openapi/openapi.yaml`, `src/common/problem.filter.ts` | validate against the spec, one error format (`application/problem+json`), raw body for the webhook, probes, `/metrics` |
| controller | `src/orders/orders.controller.ts`, `src/payments/payments.controller.ts`, … | read the request, call one service method, map the result; guards: `AccessTokenGuard`, `RolesGuard` |
| service | `src/orders/orders.service.ts`, `src/payments/payments.service.ts` | business rules: ownership, lifecycle, amount check, idempotency |
| domain operations | `src/orders/place-order.ts`, `src/orders/lifecycle.ts`, `src/orders/place-order-once.ts`, `src/payments/apply-payment.ts`, `src/outbox/outbox.ts` | the transactions themselves; know SQL, not HTTP |
| repository | `src/repositories/*.ts` | queries; no business decisions |
| background | `src/relay.ts` + `src/outbox/relay.ts`, `src/consumer.ts` + `src/messaging/order-placed.consumer.ts`, `src/realtime/order-status.feed.ts` | outbox → broker; broker → effect; broker → realtime |
| config | `src/config/env.schema.ts`, `src/config/secret-files.ts` | the only door to `process.env`; fail-fast |

| Directory | What is in it |
| --- | --- |
| `src/orders`, `src/payments` | the contour: checkout, lifecycle, webhook |
| `src/outbox`, `src/messaging` | outbox table and relay; topology, publisher with confirms, consumer |
| `src/realtime` | WebSocket gateway, SSE, owner check, the cross-process feed |
| `src/auth`, `src/health`, `src/observability` | tokens and guards; probes and drain; logs, metrics, tracing |
| `src/migrations`, `src/entities`, `src/seed.ts`, `src/migrate.ts` | schema of record; the compose one-shot |
| `src/cache`, `src/sessions`, `src/ratelimit`, `src/queue`, `src/files`, `src/storage` | Redis and file homeworks (see [Honest boundaries](#honest-boundaries)) |
| `test/unit`, `test/integration`, `test/e2e`, `test/contract`, `test/gates` | the test levels |
| `docker/Dockerfile`, `docker-compose.yml`, `infra/`, `k8s/`, `.github/workflows/` | image, local stand, Pulumi, kind, pipeline |
| `demo/`, `scripts/` | measured demos; operational scripts |

## Domain note (ДЗ0)

| | |
| --- | --- |
| **Domain and actors** | A marketplace of goods. Buyers order, sellers list products, an operator (`admin`) moves orders after payment, and an external payment provider reports payments by webhook. |
| **Main entity** | The order: lines with prices frozen at checkout, a total in minor units, an owner, and a status with a recorded history. |
| **Main scenario** | Checkout (`pending`) → fulfilment by a background consumer (`confirmed`) → payment webhook (`paid`) → operator (`shipped`); read back by `GET /orders/{id}` and `/history`, pushed live to the owner. |
| **Invariants** | Stock never goes below zero and is never sold twice. The paid amount equals the total frozen at checkout. A status moves only along the lifecycle table and never back. An order is visible only to its owner and the operator. |
| **Irreversible operations and their keys** | Placing an order — the `Idempotency-Key` header, scoped to route and user, stored with the request hash in Postgres. Applying a payment — the provider's `event_id` (`UNIQUE`). Fulfilment — the event id derived from the order (`processed_messages`). |
| **Background work** | The relay (outbox → RabbitMQ), the consumer (fulfilment + confirmation), the API's realtime feed. All are at-least-once with an idempotent effect. |
| **Load and failure expectations** | Bursts on one product (50 parallel checkouts on one SKU must sell exactly the stock). The broker may be down without stopping checkout. A process may die between any two steps. Data survives a restart; RTO 15 min committed (1.7 s measured), RPO 24 h. |

### Trade-offs

- **Transactional outbox, not publish-after-commit**, because the order and the event must
  be one fact: a crash between `COMMIT` and `publish` loses the event, and a publish before
  `COMMIT` announces an order that may roll back. Otherwise: a dual write with a
  reconciliation job. The price is latency of one relay poll and at-least-once delivery.
- **Atomic `UPDATE … SET stock = stock - n WHERE stock >= n`, not `SELECT … FOR UPDATE`**,
  because the check and the write are one statement and hold the row lock for the shortest
  time; lines are reserved in product-id order, so two carts cannot deadlock. Otherwise:
  `SERIALIZABLE` + retry on `40001` (kept, for the wallet checkout).
- **Idempotency keys in Postgres, not Redis**, because the key must commit together with
  the order it protects: a key in Redis can survive a rolled-back order or vanish under
  one that committed. Otherwise: Redis `SET NX` with a TTL, and the window that comes with it.
- **Webhook deduplication by a `UNIQUE` provider event id in an append-only table**, because
  the provider retries and its id is the business identity of the payment. A rejected
  (422) delivery is journaled too. Otherwise: a check-then-insert, which two retries race.
- **The broker is reported in `/readyz`, not gating it**, because with the outbox the API
  takes orders without RabbitMQ — gating would turn a broker outage into a full outage.
  Otherwise: a readiness that fails with any dependency.
- **`prefetch = 32`**, because one message is one short transaction and the pool has 10
  connections: `prefetch = 1` leaves the pool idle across every network round trip, and
  `32 ×` processing time stays far below RabbitMQ's 30 min consumer timeout.
- **PgBouncer in transaction mode**, because the API, relay and consumer each want a pool
  and Postgres pays for every connection. Cost: no session state, so no `LISTEN/NOTIFY` —
  which is why the realtime feed goes through RabbitMQ.
- **Runtime validation against the spec (option B), not codegen**, because a response that
  drifts from the spec becomes a 500 at the boundary instead of a silent contract break.
- **ES256 with an algorithm allowlist, not HS256**, because the verifying side never holds
  a key that can sign, and the token cannot choose its own algorithm.
- **Application secrets as files (`NAME_FILE`), not environment values**, because a file
  can be rotated without a restart and does not show up in `docker inspect`.

### Decision log

| Date | Decision | Why |
| --- | --- | --- |
| 2026-09-01 | Contract first: `openapi/openapi.yaml` is validated at runtime, both ways | the spec cannot drift from the code |
| 2026-09-01 | Config through one zod schema, fail-fast with every broken variable named | a misconfigured process must not half-start |
| 2026-09-15 | Money as integer minor units; schema only through migrations (`synchronize: false`) | no rounding; every schema change is read before it runs |
| 2026-09-15 | Checkout as atomic conditional `UPDATE`s in one transaction | no oversell without long locks |
| 2026-09-30 | PgBouncer in transaction mode; nightly `pg_dump`; restore drill with `MATCH` | connections are scarce; a backup is only a backup once restored |
| 2026-10-01 | RabbitMQ with publisher confirms, manual ack after the effect, DLQ by delivery limit | at-least-once, and a poisoned message stops looping |
| 2026-10-22 | Transactional outbox + inbox; `Idempotency-Key` in Postgres | one commit for the fact and its event |
| 2026-10-30 | ES256 access + rotated refresh with family revocation; logout = refresh revoke + access denylist | a stolen refresh token is detected on its first reuse |
| 2026-11-16 | Distroless non-root image, Pulumi on kind, PDB; one build promoted by digest through CI gates | what was tested is what runs |
| 2026-11-23 | The contour on Postgres: lifecycle table enforced in SQL, payment by signed webhook, history per change | the order's life is auditable and race-free |
| 2026-11-23 | The app in compose with one-shot `keys` and `migrate`; secrets as files | a clean clone comes up with one command |
| 2026-11-23 | `/healthz` vs `/readyz`; readiness red on SIGTERM, then drain | no request lands on a closing process |
| 2026-11-23 | Trace context stored in the outbox row and carried in AMQP headers | one trace across three processes, though the relay runs later |

## Grading, block by block

Each row: where it is, the command that shows it, and what it prints. Commands marked
*compose* run against the [Quick start](#quick-start) stack; *npm* ones need
[Running from source](#running-from-source).

### 11.1 Design and architecture

| Criterion | Where | Check |
| --- | --- | --- |
| ДЗ0 note: domain table, trade-offs, decision log | [Domain note (ДЗ0)](#domain-note-дз0) | — |
| ≥ 3 layers, logic outside controllers | [Architecture](#architecture); `scripts/gates/arch.sh` | `npm run gate:arch` → exit 0; `demo/gates.sh` shows it failing on a planted violation (`arch-broken=1`) |
| Config fail-fast, exit ≠ 0, names the variable | `src/config/env.schema.ts`, `src/main.ts` | *compose:* `docker compose run --rm --no-deps -e PAYMENT_WEBHOOK_SECRET_FILE= -e PAYMENT_WEBHOOK_SECRET=short api; echo $?` → `PAYMENT_WEBHOOK_SECRET: must be at least 32 characters (set, value withheld)`, `1`. More in [Fail-fast](#fail-fast-on-a-broken-variable) |
| Architecture diagram, API description, runbook | [Architecture](#architecture), `openapi/openapi.yaml`, [Quick start](#quick-start) | `npm run lint` → valid spec |
| Bonus: OWASP Top 10:2025 | [Security](#security-owasp-top-102025) | — |

### 11.2 Main contour and correctness

| Criterion | Where | Check |
| --- | --- | --- |
| Full contour: create → background → status → final read by a separate request | `src/orders/*`, `src/messaging/order-placed.consumer.ts`, `src/payments/*` | *compose:* `docker compose run --rm demo demo/contour.mjs` → `created=1 replayed=1 confirmed=1 paid=1 final=shipped history=4`, exit 0; e2e `runs the whole contour` |
| 50 concurrent, no oversell or lost update; a shortage rolls everything back | `src/orders/place-order.ts`; `src/concurrency/checkout.ts` | e2e `sells exactly the stock under a parallel burst` (30 requests on stock 5 → 5 × 201, 25 × 409, stock 0) and `rolls the whole checkout back when one line is short`; *npm:* `npm run demo:race` (50 parallel on stock 10, see [Race](#race-npm-run-demorace)) |
| Contract machine-checked: cursor pagination, `Idempotency-Key` required, problem+json 4xx | `openapi/openapi.yaml`, `src/bootstrap.ts`, `src/common/problem.filter.ts`, `src/common/cursor.ts` | `npm run check`; the curl step 5 above (400 problem+json without the key); e2e `keeps 400, 401, 403 and 422 apart`; Pact: `npm run test:contract && npm run verify:provider` |
| A repeated irreversible operation has one effect; the key comes from the business entity | `src/orders/place-order-once.ts` (key `route:user:key` + request hash), `src/payments/apply-payment.ts` (provider `event_id`), consumer inbox by event id | contour demo `idempotent replay` (same order, `Idempotency-Replay: true`); `demo/webhook.mjs` → `duplicates=1`; unit `checkout-request.test.ts` (same cart → same hash, other cart → 422) |

### 11.3 Data

| Criterion | Where | Check |
| --- | --- | --- |
| Persistent, constraints, migrations with a working revert, idempotent seed | `src/migrations/*` (8), `src/seed.ts` | *compose:* `down && up -d --wait`, the order is still there; *npm:* `npm run migrate:revert && npm run migrate` both exit 0; `npm run seed` twice → same rows. See [Migrations](#migrations-and-what-was-corrected-by-hand), [Seed](#seed) |
| `EXPLAIN` / N+1 | `db/OPTIMIZATIONS.md`, `src/demo-nplus1.ts` | [Data layer](#data-layer); `npm run demo:nplus1` (query count of each way) |
| PgBouncer transaction mode; restore drill `MATCH`; RTO/RPO | `pgbouncer/pgbouncer.ini`, `scripts/restore-drill.sh`, `RESTORE-DRILL.md` | `bash scripts/restore-drill.sh` → `MATCH`; RTO 1.7 s measured / 15 min committed, RPO 24 h |
| Cache-aside + jitter + single-flight; session survives restart; two Redis | `src/cache/*`, `src/sessions/*`, `docker-compose.yml` (`redis-cache`, `redis-queue`) | `npm run demo:cache` (50 reads of an expired key → 1 query), `npm run demo:session` (survives `kill -9`); [Redis](#redis-cache-sessions-limits-queue-redis-кеш-сесії-ліміти-черга) |
| Presigned files, closed bucket, CDN | `src/files/*`, `src/edge.ts` | `npm run demo:upload`, `npm run demo:cdn` (bucket 403, edge MISS → HIT); [Files](#files-файли) |

### 11.4 Security

| Criterion | Where | Check |
| --- | --- | --- |
| Logout revokes refresh and access; refresh reuse revokes the family; algorithm allowlist | `src/auth/auth.service.ts`, `src/auth/keys.ts` | e2e `kills both tokens on logout`, `revokes the whole family`; `npm run demo:auth`, `npm run demo:reuse`; [Auth](#auth-автентифікація-та-авторизація) |
| 401 vs 403; role by guard, ownership in the service; realtime only to the owner | `src/auth/guards.ts`, `src/orders/orders.service.ts`, `src/realtime/order-access.ts` | contour demo `access and validation` (403 other buyer, 401 no token), `operator ships` (buyer → 403); `npm run demo:realtime` |
| Validation of the contour input; one error format | `openapi/openapi.yaml` (runtime validator), `src/common/problem.filter.ts` | `qty 0 → 400 application/problem+json` in the contour demo |
| Secrets not in code, git or image layers | `.gitignore`, `.dockerignore`, `src/config/secret-files.ts`, `src/compose-keys.ts` | `npm run demo:image` → `token-in-history=0 token-in-config=0 token-in-layers=0`; `docker inspect r_d-api-1 --format '{{.Config.Env}}'` shows file paths (`*_FILE`) and URLs without passwords, no secret value |
| Edge: rate limit 429 + `Retry-After` on a shared store; webhook signature, duplicate, amount | `src/ratelimit/sliding-window.ts`, `src/payments/signature.ts` | `npm run demo:ratelimit`; *compose:* `demo/webhook.mjs` → `accepted=1 rejected-signature=1 amount-mismatch=1 duplicates=1` |
| Bonus: secret store dev ≠ prod, rotation live | `scripts/with-secrets.sh`, `store/`, `rotate.sh`, `scripts/jwt-keys.mjs` | [Secrets and their rotation](#secrets-and-their-rotation) |

### 11.5 Asynchrony

| Criterion | Where | Check |
| --- | --- | --- |
| Background work changes state, read by a separate request | `src/messaging/order-placed.consumer.ts` | contour demo `background: consumer confirmed it`; e2e consumer in-process `pending → confirmed` |
| Outbox in one `COMMIT`; publisher confirms; prefetch justified; at-least-once with an idempotent effect; dedup survives a restart | `src/outbox/*`, `src/messaging/publisher.ts`, `processed_messages` table | `npm run demo:crash-write`, `demo:crash-relay` (2 deliveries, 1 effect), `demo:duplicate`; [Outbox](#transactional-outbox-and-idempotency-outbox-та-ідемпотентність), [prefetch](#prefetch--32) |
| Workers exactly once; retry on `40001` / `40P01`; DLQ | `src/concurrency/worker.ts`, `src/concurrency/retry.ts`, `src/messaging/topology.ts` | `npm run demo:workers`, `demo:retry`, `demo:dlq` (reason from `x-death`) |
| Realtime only to the owner; SSE `Last-Event-ID` | `src/realtime/*` | `npm run demo:realtime` and `:same-room`; [Last-Event-ID](#last-event-id-a-reconnect-that-loses-nothing) |

### 11.6 Delivery

| Criterion | Where | Check |
| --- | --- | --- |
| `docker compose up -d --wait` from a clean clone per README; no hidden steps; data survives a restart; waits for dependencies | `docker-compose.yml`, `scripts/acceptance.sh` | `evidence/acceptance.txt` (fresh clone, cold build, `failed steps and checks: 0`); [Quick start](#quick-start); `depends_on: service_healthy / service_completed_successfully` everywhere; `down && up -d --wait` keeps orders and keys |
| Production image: multi-stage, no shell, non-root, no build secret, scanner threshold | `docker/Dockerfile`, `scripts/scan.sh` | `npm run demo:image` → `stages=4 shell-inside=0 runtime-uid=65532 token-in-*=0`; `SCAN_MAX=-1 npm run scan` → `gate=fail`, exit 1. See [The image](#the-image), [The scan gate](#the-scan-gate) |
| IaC deploy, rollout `failed=0`, two probes, SIGTERM | `infra/` (API, relay, consumer, Postgres, RabbitMQ, migrate Job), `k8s/`, `demo/rollout.sh` | `npm run up` → the whole contour in kind; `demo/contour.mjs` against it → `final=shipped`; `npm run demo:rollout` under load on `GET /products` → `failed=0`. See [Kubernetes: the full contour](#kubernetes-the-full-contour) |
| Off-machine deploy: green deploy run by digest, or a teardown run | `.github/workflows/pr.yml`, `deploy.yml`, `teardown.yml` | green `pr` run on PR #23 (built = deployed = registry digest, `failed=0`), teardown run in [AWS](#aws) |

### 11.7 Operations and quality

| Criterion | Where | Check |
| --- | --- | --- |
| Liveness and readiness on different paths; readiness red on SIGTERM | `src/bootstrap.ts`, `src/health/readiness.service.ts`, `src/main.ts` | `curl localhost:3000/readyz` → `{"status":"ready","checks":{"database":"up","broker":"up"}}`; `docker compose kill -s SIGTERM api` → `/readyz` 503 at once, `/healthz` 200 through the 5 s drain, exit 0; e2e `probes.e2e.test.ts` |
| Structured logs, one `trace_id`, no secrets | `src/observability/logger.ts`, `request-log.ts`, `amqp-trace.ts` | `docker compose logs --no-log-prefix api relay consumer \| grep <checkout_trace>` → lines from all three processes; `npm run demo:logs` → `secret-in-logs=0` |
| RED metrics, OTel continues `traceparent`, dashboard as a file | `src/observability/metrics.ts`, `observability/grafana/dashboards/marketplace-red.json` | `demo/contour-trace.mjs` → 5 hops, 0 orphans; Grafana row *Main contour*; `npm run demo:metrics`, `demo:trace` |
| Tests: integration against a real DB, twice green; e2e of the contour; business logic without HTTP | `test/integration` (orders, products, `order-history.test.ts`, `payments.test.ts`), `test/e2e/orders.e2e.test.ts`, `test/unit/lifecycle.test.ts` | `npm run test:integration` (run it twice), `npm run test:e2e`, `npm run test:unit` |
| A pipeline in which every gate can say no | `.github/workflows/*`, `demo/gates.sh` | `npm run demo:gates` → `<step>-ok=0`, `<step>-broken=1` for each gate; [CI/CD](#cicd) |

## Environment variables

Declared once in `src/config/env.schema.ts`, documented in `.env.example`, checked by
`npm run check:env`. In compose every secret arrives as a file: for any variable of the
store (`JWT_*`, `REFRESH_TOKEN_PEPPER`, `STORAGE_SECRET_KEY`, `PAYMENT_WEBHOOK_SECRET`),
`NAME_FILE` names a file holding the value (`src/config/secret-files.ts`); a value already
in the environment wins.

| Variable | Required | Default | Source | Purpose |
| --- | --- | --- | --- | --- |
| `NODE_ENV` | no | `development` | environment | `development` \| `test` \| `production` |
| `PORT` | no | `3000` | environment | HTTP port |
| `DB_URL` | **yes** (or `DATABASE_URL`) | — | `.env` / compose | Postgres URL **without** a password; the schema rejects one with a password |
| `DB_PASSWORD_FILE` | no | `./secrets/db_password` | environment (a path) | the password, re-read on every new connection (rotation) |
| `DATABASE_URL` | no | — | environment | grader-style alternative with the password inside; `DB_URL` wins |
| `DB_POOL_MAX`, `DB_CONNECTION_TIMEOUT_MS` | no | `10`, `5000` | environment | pool size, wait for a connection |
| `LOG_LEVEL` | no | `info` | environment | `debug` \| `info` \| `warn` \| `error` |
| `SHUTDOWN_DRAIN_MS` | no | `5000` | environment | SIGTERM → `/readyz` 503 for this long → close |
| `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `JWT_KID`, `REFRESH_TOKEN_PEPPER` | **yes** | — | store / `keys` volume | ES256 signing pair and the refresh pepper ([Auth → Variables](#variables-1)) |
| `JWT_PREVIOUS_PUBLIC_KEY`, `JWT_PREVIOUS_KID` | no | — | store | the retiring key during a rotation |
| `JWT_ISSUER`, `JWT_AUDIENCE`, `JWT_ACCESS_TTL_SECONDS`, `REFRESH_TTL_SECONDS` | no | `marketplace-api`, `600`, 30 days | environment | token claims and lifetimes |
| `BROKER_URL` | no | — | environment | RabbitMQ URL without a password; the API's realtime feed |
| `BROKER_PASSWORD_FILE` | no | — | environment (a path) | the broker password |
| `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY` | bucket, key id: **yes** | region `us-east-1` | environment | object storage ([Files → Variables](#variables-2)) |
| `STORAGE_SECRET_KEY` | **yes** | — | store | storage secret key |
| `UPLOAD_PUT_TTL_SECONDS` | no | see Files | environment | lifetime of a presigned PUT |
| `PAYMENT_WEBHOOK_SECRET` | **yes**, ≥ 32 chars | — | store / `keys` volume | HMAC key of the provider's webhook |
| `METRICS_PORT` | no | — | environment | `/metrics` of the relay and the consumer (compose: `9464`) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | — | environment | where spans go (compose: `http://jaeger:4318`); unset → no export, trace ids still in logs |
| `SKIP_VAULT` | no | — | environment | `with-secrets.sh` skips the store; the caller exports the values |

## Security: OWASP Top 10:2025

| Risk | What this project does | Where |
| --- | --- | --- |
| A01 Broken Access Control | role by `RolesGuard`, ownership checked in the service (403 for another buyer's order), realtime rooms only for the owner, admin-only status changes | `src/auth/guards.ts`, `src/orders/orders.service.ts`, `src/realtime/order-access.ts` |
| A02 Security Misconfiguration | fail-fast config, no default secrets in code, closed bucket, Grafana without anonymous access or sign-up, management ports bound to `127.0.0.1` for the obs stand | `src/config/env.schema.ts`, `docker-compose.yml` |
| A03 Software Supply Chain Failures | `npm ci` from a lockfile, every image pinned to a version, Trivy gate on the image, one build promoted by digest | `docker/Dockerfile`, `scripts/scan.sh`, `.github/workflows/build.yml` |
| A04 Cryptographic Failures | ES256 with an algorithm allowlist, refresh tokens stored as peppered hashes, `timingSafeEqual` for the webhook HMAC, scrypt for passwords | `src/auth/*`, `src/payments/signature.ts` |
| A05 Injection | parameterised SQL everywhere; request bodies validated against the spec before a controller runs | `src/repositories/*`, `src/bootstrap.ts` |
| A06 Insecure Design | the lifecycle as a table enforced in SQL, frozen payment amount, idempotency keys, outbox | `src/orders/lifecycle.ts`, `src/orders/place-order.ts` |
| A07 Authentication Failures | the same 401 for a wrong password and an unknown e-mail, refresh rotation with reuse detection, logout kills both tokens | `src/auth/auth.service.ts`, e2e `auth.e2e.test.ts` |
| A08 Software or Data Integrity Failures | webhook signed over the raw body, amount mismatch rejected and journaled, append-only payment events | `src/payments/*` |
| A09 Security Logging and Alerting Failures | structured logs with `trace_id` and `layer`, secrets redacted (`secret-in-logs=0`), 4xx/5xx rates on the dashboard | `src/observability/*`, `demo/logs.mjs` |
| A10 Mishandling of Exceptional Conditions | one problem+json filter, no stack traces to clients, readiness red while draining, DLQ for poison messages, retry on `40001`/`40P01` | `src/common/problem.filter.ts`, `src/health/*`, `src/messaging/topology.ts` |

## Secrets and their rotation

Nothing secret is in git, in the image or in an environment value of a container. Locally
the values come from an encrypted store per environment (`store/*.enc`, opened by
`scripts/with-secrets.sh dev` with a key outside git), so dev and CI never share a value. In
compose, the infrastructure passwords are the committed dev values from
`secrets/*.example`, mounted as compose secrets, and the application's own secrets — the
JWT signing pair, the refresh pepper, the webhook key — are generated by the `keys` one-shot
into a volume on the first `up` and never leave it. The image has no `ENV` with a secret
and no secret in a layer (`npm run demo:image`). Rotation is live: the database password
through `rotate.sh` without a restart ([how](#rotating-the-database-password-without-a-restart)),
the signing key through `scripts/jwt-keys.mjs rotate|retire` with the previous key still
verifying during the overlap ([Auth](#auth-автентифікація-та-авторизація)).

## Kubernetes: the full contour

`npm run up` deploys the coursework API to the kind cluster with all of its contour, not the
probe stub of homework 28. One Pulumi program (`infra/index.ts`, `infra/backing.ts`) creates
15 resources:

| Resource | What runs | Why this shape |
| --- | --- | --- |
| StatefulSet `postgres` + headless Service | `postgres:16-alpine`, 1 Gi PVC, `pg_isready` over TCP as readiness | the data outlives a pod restart; the readiness check skips initdb's socket-only server |
| StatefulSet `rabbitmq` + headless Service | `rabbitmq:4.2-alpine`, 1 Gi PVC, `check_running` as readiness | a stable host name: the node is `rabbit@rabbitmq-0`, and its data directory is tied to that name |
| Job `migrate-<hash>` | `dist/migrate.js`: migrations, then the idempotent seed | named per image: a Job's template cannot change, so a new digest means a new Job. `pulumi up` waits for it, and everything that reads the schema depends on it |
| Deployment `marketplace-api` (3), Service NodePort 30080, PDB, HPA | `dist/main.js`, `/readyz` (pg) and `/healthz` as two probes, `SHUTDOWN_DRAIN_MS=5000` | the same rollout rules as homework 28, now on the real Nest app |
| Deployments `marketplace-api-relay`, `marketplace-api-consumer` (1 each) | `dist/relay.js`, `dist/consumer.js`, `/metrics` on 9464 | the background half: outbox → broker, `order.placed` → `confirmed` |
| Secret `marketplace-api-secrets`, Namespace | 8 store values | see below |

**Secrets.** Each store value Pulumi reads (`DB_PASSWORD`, `BROKER_PASSWORD`, `STORAGE_SECRET_KEY`,
`JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `JWT_KID`, `REFRESH_TOKEN_PEPPER`, `PAYMENT_WEBHOOK_SECRET`) goes
into one Secret. The app pods mount that Secret as files under `/run/secrets/app` (mode 0440,
group 65532) and read them through the same `NAME_FILE` variables compose uses. Postgres reads
`POSTGRES_PASSWORD_FILE`, and RabbitMQ gets its password by `secretKeyRef`. No pod spec holds a
value: `scripts/ci/manifest.sh` looks for every store value, plain and base64, in all Deployments,
StatefulSets, Jobs and Services and finds 0. Given the Secret itself as a control, it finds 8.
`infra/config.ts` checks every name before it declares any resource, so a missing one stops
`pulumi preview` with that name.

**What was measured** (kind v0.33.0, one node, local Docker, 2026-11-23):

```
npm run image:build && npm run cluster:up && npm run up      # 15 created, 53 s
BASE_URL=http://127.0.0.1:30080 bash scripts/with-secrets.sh dev node demo/contour.mjs
  # created=1 replayed=1 confirmed=1 paid=1 final=shipped history=4, exit 0
BASE_URL=http://127.0.0.1:30080 bash scripts/with-secrets.sh dev node demo/webhook.mjs
  # accepted=1 rejected-signature=1 amount-mismatch=1 duplicates=1
npm run demo:rollout                  # requests=30524 ok=30524 failed=0 rollout-seconds=21
PROFILE=broken npm run demo:rollout   # requests=13626 failed=5664, exit 1 (no probes, no drain)
npm run demo:pdb                      # healthy=3 evict-1=201 evict-2=429
```

`demo:rollout` now puts its load on `GET /products`, a real route through Nest and the pool to
Postgres. It used to hit the stub's `/`. A probe would be the wrong target: `/readyz` is meant to
go red while a pod drains, and a request during the drain must still be served.

**Cost gate.** `src/mapping.ts` now charges a StatefulSet for its volume claims too. The stand is
$11.86 a month at Fargate and EBS rates (API 5.65, RabbitMQ 2.17, Postgres 1.96, relay 1.04,
consumer 1.04), against a base of about $5.04 for the stub. The delta fits the `max($10, 20 %)` budget.

**In CI** (`deploy-kind.yml`) the same program runs on the digest the build job produced and the
store `store/ci.enc`. After `pulumi up`, a step runs `demo/contour.mjs` through the NodePort with
the store's webhook key, so a key that never reached the pods fails the job. `demo:rollout` and
both manifest checks follow. `contour-final` and `contour-history` go into `deploy-evidence.txt`.
`scripts/store-ci.sh fill` added the new values to the CI store under the same key, so the
`STORE_KEY` of the `kind` environment did not change.

**Without the store** (a grader), the variables are exported first, as in
[the Kubernetes run](#kubernetes-the-rollout-homework):

```bash
export SKIP_VAULT=1 PULUMI_BACKEND_URL="file://$PWD/.pulumi" PULUMI_CONFIG_PASSPHRASE=grading
export DB_PASSWORD="$(openssl rand -hex 16)" BROKER_PASSWORD="$(openssl rand -hex 16)"
export STORAGE_SECRET_KEY="$(openssl rand -hex 16)" REFRESH_TOKEN_PEPPER="$(openssl rand -hex 16)"
export PAYMENT_WEBHOOK_SECRET="$(openssl rand -hex 32)" JWT_KID=grading-1
pem="$(openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256)"
export JWT_PRIVATE_KEY="$(printf '%s\n' "$pem" | base64 | tr -d '\n')"
export JWT_PUBLIC_KEY="$(printf '%s\n' "$pem" | openssl pkey -pubout | base64 | tr -d '\n')"
npm --prefix infra ci && printf dummy > .npm_token
npm run image:build && npm run cluster:up && npm run up
BASE_URL=http://127.0.0.1:30080 node demo/contour.mjs     # final=shipped, exit 0
npm run demo:rollout                                       # failed=0
npm run destroy && npm run cluster:down
```

## Honest boundaries

- **Kubernetes runs the contour, not everything.** kind gets the API, relay, consumer,
  Postgres and RabbitMQ ([Kubernetes: the full contour](#kubernetes-the-full-contour)).
  pgbouncer, Redis, object storage and the observability stand stay in compose: no route of the
  contour needs them, and the file routes answer 5xx there. Postgres and RabbitMQ are single
  replicas on kind's local-path volumes, which is a stand, not a production database.
- **Redis is not in the contour.** Cache-aside, sessions and the shared rate limit live in
  their homework processes (`src/pod.ts`, the demos), not in the Nest API that compose runs.
- **Products and files still use the in-memory `IdempotencyService`.** The orders contour
  uses the Postgres one; the others were not migrated.
- **The contract gate flags the status enum** (`created` → `pending`, `confirmed` added) as
  a breaking change against the base branch — expected for this PR.
- **The payment provider is simulated** by the demos (`demo/lib/api-client.mjs` signs like a
  provider would); there is no real payment integration.

## Running from source

For the npm demos and the test suites. Needs Node 22, Docker, and either access to the
store (`npm run start:vault` etc.) or `SKIP_VAULT=1` with the values exported (the
reviewer blocks under [Grading](#grading) show how).

```bash
npm ci
docker compose up -d --wait postgres pgbouncer rabbitmq redis-cache redis-queue storage
npm run build && npm run migrate && npm run seed
npm run start:vault           # API on 3000 — stop the compose api first, it holds the port
npm run relay & npm run consumer &
BASE_URL=http://localhost:3000 npm run demo:contour
npm run test:unit && npm run test:integration && npm run test:e2e
```

`npm start` is `npm run build && node dist/main.js` on purpose — not a watch mode, so the
fail-fast exit code can be tested. Watch mode is `npm run start:dev`.

## Commands

| Command | What it does |
| --- | --- |
| `npm start` | builds and runs the app on the configured `PORT` |
| `npm run start:vault` | the same, with the keys and the database credentials from the store (`with-secrets.sh dev`) |
| `npm run start:dev` | watch mode (`nest start --watch`) |
| `npm run build` | compiles TypeScript into `dist/` |
| `npm run check:env` | verifies `.env.example` still matches the zod schema |
| `npm run migrate` | applies every pending TypeORM migration from `dist/migrations` |
| `npm run migrate:show` | lists migrations, `[X]` applied / `[ ]` pending |
| `npm run migrate:revert` | rolls the last migration back through its `down()` |
| `npm run migrate:generate -- src/migrations/Name` | diffs entities against the live database |
| `npm run seed` | deterministic, idempotent fixture data |
| `npm run demo:nplus1` | the same read three ways, with the SQL query count of each |
| `npm run report` | revenue per seller — aggregate through `createQueryBuilder()` |
| `npm run demo:race` | 50 parallel checkouts against `stock = 10`, with invariant checks |
| `npm run demo:workers` | worker pool draining the job queue with `FOR UPDATE SKIP LOCKED` |
| `npm run demo:retry` | provokes `40001` and retries the whole transaction with backoff |
| `npm run demo:realtime` | two WebSocket clients in different rooms; only the addressed one hears the event |
| `npm run demo:realtime:same-room` | the control run: both clients in one room, so both must hear it |
| `npm run demo:contour` | the coursework contour against `BASE_URL`: create, replay, 401/403/400, confirmed, paid, shipped, history |
| `npm run demo:webhook` | the webhook's four answers: accepted, forged signature, amount mismatch, duplicate |
| `npm run demo:contour-trace` | one trace across api → relay → consumer, read back from Jaeger (`TRACE_API_URL`) |
| `npm run test:unit` | business logic without HTTP or a database: lifecycle, signature, checkout identity, trace context |
| `npm run gate:types` / `gate:contract` / `gate:arch` | the gates of the pipeline, runnable locally |
| `npm run demo:gates` | every gate on a correct and on a broken input: `<step>-ok=0`, `<step>-broken=1` |
| `npm run consumer` | the `order.placed` consumer: manual ack, prefetch 32, idempotent effect |
| `npm run demo:publish` | 5 checkouts → 5 `order.placed` → 5 effects, 5 acks, empty DLQ |
| `npm run demo:dlq` | a poisoned message is rejected into the DLQ; the reason is read from `x-death` |
| `npm run demo:duplicate` | the consumer is `kill -9`-ed after the effect, before the ack: 2 deliveries, 1 effect |
| `npm run relay` | the outbox relay: `FOR UPDATE SKIP LOCKED` → publish → `UPDATE published_at` |
| `npm run demo:outbox` | 2 requests with one `Idempotency-Key` → 1 order, 1 outbox row, 1 delivery, 1 effect |
| `npm run demo:crash-write` | the transaction fails after the outbox insert: no order, no row, nothing published |
| `npm run demo:crash-relay` | the relay is `kill -9`-ed between publish and `UPDATE`: 2 deliveries, 1 effect |
| `npm run demo:cache` | 60 cards warmed with jittered TTLs; 50 concurrent reads of an expired key → 1 query |
| `npm run demo:session` | a session in Redis with a rolling TTL, surviving a `kill -9` of the process |
| `npm run demo:ratelimit` | two pods, one sliding window: `limit` allowed between them, the rest 429 + `Retry-After` |
| `npm run demo:queue` | BullMQ: retries with exponential backoff, dedup by `jobId`, one upserted job scheduler |
| `npm run demo:auth` | login → refresh → logout: both tokens of the session dead, the access token through the denylist |
| `npm run demo:reuse` | a replayed refresh token revokes its whole family, the honest client's newest token included |
| `npm run demo:rbac` | 401 vs 403: no token, the owner, a stranger, a buyer writing products, a forged `role: admin` |
| `npm run demo:upload` | intent → PUT straight to storage while the API is down → commit; a forged key and an expired URL are 403 |
| `npm run demo:multipart` | a multipart upload killed after 2 of 3 parts; a new process sends only part 3 |
| `npm run demo:cdn` | the bucket is 403, the edge is MISS → HIT, a new version arrives under a new hashed name |
| `npm run edge` | the edge cache in front of the bucket (`assets/*`, `X-Cache: HIT\|MISS`) |
| `node scripts/jwt-keys.mjs generate\|rotate\|retire\|fingerprint <env>` | the ES256 keys and the pepper of an environment in `secrets/jwt/<env>/` |
| `npm run pod` | one stateless API pod: sessions (`GET /session`) and the rate limit (`GET /limited`) |
| `npm run image:build` | `docker/Dockerfile` → `marketplace-api:1.0.0`, the registry token as a BuildKit secret from `.npm_token` |
| `npm run scan` | Trivy on the image; `found` vs `SCAN_MAX` → `gate=pass\|fail` and the exit code |
| `npm run cluster:up` / `cluster:down` | one kind node (`k8s/kind-config.yaml`) + `kind load docker-image` / delete it |
| `npm run up` / `preview` / `destroy` | the Pulumi program in `infra/` through `with-secrets.sh`, local file backend |
| `npm run demo:image` | stages, shell, runtime uid, and the token in history, config and layers |
| `npm run demo:rollout` | a rolling update under load: `requests`, `ok`, `failed` counted from a file of response codes |
| `npm run demo:pdb` | two evictions through the Eviction API: `evict-1=201`, `evict-2=429` |
| `npm run obs:up` / `obs:down` | the observability stand (`observability/compose.yml`): Prometheus 22901, Grafana 22903, Jaeger 22904 + OTLP 22918 |
| `npm run demo:logs` | one checkout, a burst of 10 and a login with two secret markers: one trace_id per request, ≥ 3 layers, no marker in the log |
| `npm run demo:metrics` | 60 checkouts (fast, slow, failing) between two scrapes, then 100 different order ids: deltas, `above-top-bucket`, series before/after |
| `npm run demo:trace` | a failing checkout with our own `traceparent`: the trace from Jaeger vs the header vs the log |
| `npm run db:schema` | *(raw-SQL path of the data-layer homework)* applies `db/schema.sql` |
| `npm run db:seed` | applies `db/seed.sql` (≈590 000 rows, ends with `VACUUM (ANALYZE)`) |
| `npm run db:indexes` | applies `db/indexes.sql` + `ANALYZE` |
| `npm run db:psql` | opens a psql shell on the running container |
| `bash scripts/backup.sh` | `pg_dump -Fc` into a dated file under `backups/` |
| `bash scripts/restore-drill.sh` | restores the newest dump into a throwaway container and prints `MATCH` |
| `bash rotate.sh` | rotates the password in Postgres, PgBouncer and the password file |
| `npm run test:integration` | repositories against a Postgres the test run starts itself |
| `npm run test:e2e` | the whole application over HTTP, through supertest |
| `npm run test:contract` | the consumer side of the Pact contract → `pacts/*.json` |
| `npm run verify:provider` | the real application replayed against that contract |
| `bash scripts/pact-gate.sh publish\|tag-prod\|can-i-deploy` | the broker side of the loop |
| `npm run lint` | `redocly lint openapi/openapi.yaml` |
| `npm run bundle` | `redocly bundle openapi/openapi.yaml -o spec.json` |
| `npm run check` | every acceptance criterion for the spec in one run |
| `npm run smoke` | builds, then runs every contract criterion against the live app (needs Postgres up) |

`npm run check` and `npm run smoke` perform exactly the same checks as the raw
commands below, just collected into one run with readable output.

# Appendix: the homeworks one by one

Everything below is the record of the homeworks this project grew from, in the order
they were done. The coursework part above links here where an older homework is the
evidence for a grading row. Some commands below predate the compose application (they
start their own processes from `dist/`); they still work as written.

# Contract first (homework 09)

Chosen contract option: **B — runtime validation at the boundary**
(NestJS + `express-openapi-validator`).

`openapi/openapi.yaml` is not documentation sitting next to the code — it is the
source of truth the validator checks **both requests and responses** against.
Anything that contradicts the spec does not cross the boundary: an invalid request
is rejected before it reaches a controller (400), and a response that has drifted
away from its schema never reaches the client (500 instead of silent drift).

# Configuration

Configuration flows in one direction, and every step is enforced rather than assumed:

```
process.env  →  zod schema (fail-fast)  →  ConfigService<Env, true>  →  code
secrets/db_password  →  password: () => readFile()  →  pg.Pool  →  database
```

Nothing reads `process.env` directly outside `src/config/env.schema.ts`: the schema
is the only door, and `ConfigService<Env, true>` is the only way the code sees a value.

## Variables

Every variable is declared once, in `src/config/env.schema.ts`, and documented in
`.env.example`. Types come from `z.coerce` because everything arriving from the
environment is a string.

The full table, with the coursework's variables, is [Environment variables](#environment-variables).

The database connection lives in the store this project already had, not in a new env
file: `DB_URL` carries no password, and the password itself is a separate file
(`DB_PASSWORD_FILE`) that can be rotated while the service runs. No tracked env file
other than `.env.example` contains a connection string.

The dev credentials of the Postgres container itself stay in `docker-compose.yml` on
purpose — those are two different paths. The application reads its secret from the
store; a reviewer with a fresh clone needs a local stand that comes up without one.

The password is deliberately **not** an environment variable. It lives in a file so it
can be replaced while the process is running — see the rotation section below.

## Fail-fast on a broken variable

`validate` from the schema is passed to `ConfigModule.forRoot`, so it runs before the
DI graph is built. It reports **all** broken variables at once, not one per restart:

```bash
mv .env /tmp                    # otherwise dotenv quietly supplies the value
env -u DB_URL npm run start
echo $?                         # 1
mv /tmp/.env .
```

```
Invalid environment configuration — 1 problem(s):
  - DB_URL: Required (not set)

Every variable is documented in .env.example. Fix the values above and start again.
```

## Keeping .env.example honest

`.env.example` is a contract in git: every variable from the schema, each with a
comment, and only fake secret values. `npm run check:env` compares the two and fails
if the file has fallen behind:

```bash
npm run check:env     # exit 0
# delete any line from .env.example
npm run check:env     # exit 1, naming the missing variable
```

It checks three things: no variable is missing, no variable is extra, and the
documented values actually satisfy the schema.

## Rotating the database password without a restart

This is the part that separates "secrets as env" from "secrets as a managed
resource". The password is supplied to `pg.Pool` as a **function**, so every new
connection re-reads the file:

```ts
password: async () => (await readFile(passwordFile, 'utf8')).trim(),
```

Step by step:

```bash
# 1. note the uptime and pid
curl -s localhost:3000/health
# {"status":"ok","uptime_seconds":20.436,"pid":84709}

# 2. rotate
bash rotate.sh

# 3. a request that goes to the database still answers
curl -s -o /dev/null -w '%{http_code}\n' 'localhost:3000/products?limit=2'
# 200

# 4. uptime kept growing and the pid is unchanged — nothing restarted
curl -s localhost:3000/health
# {"status":"ok","uptime_seconds":20.87,"pid":84709}
```

`rotate.sh` does four things, and the order is the whole point:

1. `ALTER ROLE` — the database learns the new password first.
2. Rewrite `pgbouncer/userlist.txt` and `SIGHUP` the pooler — PgBouncer authenticates its
   own clients against that file *and* uses it to log in to Postgres.
3. Write `secrets/db_password` — new connections start using it.
4. `pg_terminate_backend` — connections opened with the old password are dropped, and
   the pool transparently reopens them.

Writing the file first would leave a window where every new connection authenticates
with a password the database does not know yet. Skipping step 2 would be worse: since
the pooling homework the application never talks to Postgres directly, so a stale
userlist locks out everything at once. The file is truncated in place rather than
replaced — Docker bind-mounts a single file by inode, and `mv` would leave the
container reading the old one.

`src/db/database.module.ts` registers `pool.on('error', …)`. Without it, the idle
clients killed by `pg_terminate_backend` would emit an unhandled `'error'` event and
take the process down — which looks like a broken rotation but is really a missing
handler.

### After `docker compose down -v`

The volume is deleted, so Postgres comes back with the password from
`docker-compose.yml`, while `secrets/db_password` still holds the rotated one. Restore
it, or authentication fails:

```bash
printf 'marketplace_dev_password' > secrets/db_password
```

## Secrets stay out of git and out of the image

`.env` and `secrets/` are in `.gitignore`; only `.env.example` is tracked.

```bash
git check-ignore .env                                  # .env
git ls-files | grep -c '.env$'                         # 0
git status --ignored --porcelain | grep -E '^!! .*\.env$'   # !! .env
```

`.dockerignore` keeps the same two out of every layer, and the Dockerfile declares no
`ENV` of its own:

```bash
docker build -t myapp .
docker run --rm myapp ls -a /app                       # .env.example, no .env, no secrets/
docker run --rm myapp sh -c 'cat /app/.env' 2>&1       # No such file or directory
docker inspect --format '{{.Config.Env}}' myapp        # only PATH, NODE_VERSION, YARN_VERSION
docker history --no-trunc myapp | grep -i password     # empty
```

# Data layer

Four tables — `users`, `products`, `orders`, `order_items` — wired by four foreign keys.
Money is `numeric(12,2)`, time is `timestamptz`, and `CHECK` constraints keep statuses and
currencies from drifting into free text. This is the raw-SQL design and the volume the
`EXPLAIN` work below was measured on; the ORM layer that replaced it as the schema of
record keeps the same tables and indexes but stores money as integer minor units.

| | Table | Rows after `db/seed.sql` |
| --- | --- | ---: |
| **main table** | `orders` | 150 000 |
| **table q4 searches** | `products` | 120 000 |
| | `order_items` | ~300 000 |
| | `users` | 20 000 |

## Bring the database up, and connect to it

One line each, both working on a fresh clone with no file edits — the dev credentials
live in `docker-compose.yml`:

```bash
docker compose up -d --wait
```

```bash
docker compose exec -T postgres psql -U marketplace -d marketplace
```

## Run every step

Exactly the order the whole thing is meant to be reproduced in — clean volume first, so
nothing is left over from a previous run:

```bash
docker compose down -v && docker compose up -d --wait

npm run db:schema                       # db/schema.sql  — tables, constraints, tsvector column
npm run db:seed                         # db/seed.sql    — ~590k rows, ends with VACUUM (ANALYZE)

# "before": every one of the four queries is a Seq Scan
for n in 1 2 3 4; do
  docker compose exec -T postgres psql -U marketplace -d marketplace \
    -c "EXPLAIN (ANALYZE, BUFFERS) $(cat db/queries/q$n.sql)"
done

npm run db:indexes                      # db/indexes.sql + ANALYZE

# "after": no Seq Scan, and each plan names the index from db/indexes.sql
for n in 1 2 3 4; do
  docker compose exec -T postgres psql -U marketplace -d marketplace \
    -c "EXPLAIN (ANALYZE, BUFFERS) $(cat db/queries/q$n.sql)"
done
```

Run q4 two or three times and take the last: the first call after `CREATE INDEX` walks a
cold GIN and reports a time an order of magnitude worse than the real one.

The four queries, the indexes that cure them, and the before/after plans with buffer
counts are in [db/OPTIMIZATIONS.md](db/OPTIMIZATIONS.md).

| Query | What it answers | Index it ends up using |
| --- | --- | --- |
| `db/queries/q1.sql` | a buyer's orders inside a date range | `idx_orders_buyer_created_at` (composite) |
| `db/queries/q2.sql` | recent refunds | `idx_orders_refunded_created_at` (**partial**) |
| `db/queries/q3.sql` | user lookup by e-mail, case-insensitive | `idx_users_email_lower` (**expression**) |
| `db/queries/q4.sql` | catalogue full-text search | `idx_products_search_vector` (**GIN over tsvector**) |

## A note on the API and the schema

The database uses domain names — `name`, `description`, `price_minor` — while the HTTP
contract from the OpenAPI spec keeps `title` and `price_cents`. `ProductsService` bridges
the two in SQL (`name AS title`, `price_minor AS price_cents`), and the published contract
did not have to change to accommodate a schema decision. Money was `numeric(12,2)` when
this section was written; the ORM homework below moved it to an integer number of minor
units, which turned that bridge from a conversion into a rename.

# ORM layer: entities, migrations, N+1

The SQL schema from the data-layer homework now lives in code: four entities, four foreign
keys with a deliberate `onDelete` each, and one migration that builds the schema from
nothing. `synchronize` is `false` in `src/data-source.ts` — the schema changes only through
a migration file that was read before it was run.

One thing changed representation on the way in: money is now `integer` in **minor units**
(`price_minor`, `unit_price_minor`, `total_minor`) instead of `numeric(12,2)`. Integer
kopiyky cannot round, cannot be compared wrongly, and survive JSON without a decimal
string; the HTTP contract already spoke `price_cents`, so `ProductsService` lost its
`(price * 100)::int` conversion and now just renames `price_minor AS price_cents`.
`db/schema.sql` and `db/seed.sql` stay as the record of the previous homework — they are
not meant to be applied on top of a migrated database, and the migrations are the schema
of record from here on.

## Grading

### CI/CD (the pipeline homework)

What is graded is the PR's run on GitHub (the `pr-run:` line in [CI/CD](#cicd)) and the three
local demos below. None of them talks to GitHub, needs a cluster, or needs the store. Docker is
needed for the scanner and for `oasdiff`, which runs as an image pinned by digest when no local
binary is found. The image is built once if it is missing. `package.json` is in the repository
root.

```bash
git clone https://github.com/martsyniuk-denys/r_d && cd r_d && git checkout feature/homework_30
npm ci

export SKIP_VAULT=1               # the grader has no access to the store
export DB_PASSWORD=grader-secret  # the only app secret the stand reads (the сховище table in CI/CD)

npm run demo:gates                # four steps, both sides: <step>-ok=0, <step>-broken=1
npm run demo:oidc                 # case=green 1 1, case=foreign-sub 1 0, case=bad-signature 0 0
PLAN_JSON=/tmp/hw32/plan.json COST_BUDGET_USD=0      npm run gate:cost   # gate=fail, exit 1
PLAN_JSON=/tmp/hw32/plan.json COST_BUDGET_USD=999999 npm run gate:cost   # gate=pass, exit 0
```

`plan.json` comes from the run's `pipeline-evidence` artifact
(`gh run download <run> -n pipeline-evidence -D /tmp/hw32`). It is not committed. The GHCR
package `ghcr.io/martsyniuk-denys/r_d` is public, so criterion 5 can compare the digest with the
registry.

### AWS (the cloud homework, fallback lane: LocalStack)

The grader's gate is the teardown run linked at the top of [AWS](#aws), not anything on this
machine. To repeat the local half without a store, Docker and the AWS CLI are enough. The
LocalStack key pair is the public `test`/`test`, and the passphrase only encrypts a throwaway
local state. `package.json` (root) has the npm scripts.

```bash
export SKIP_VAULT=1                                   # the grader has no access to the store
export AWS_ENDPOINT_URL=http://127.0.0.1:23166        # LocalStack, never real AWS
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test
export PULUMI_BACKEND_URL="file://$PWD/.pulumi" PULUMI_CONFIG_PASSPHRASE=hw31-grading
export DB_PASSWORD=grader-secret                      # the RDS master password the demo stack asks for
npm run localstack:up                                 # localstack/localstack:4.14.0 on 23166

for d in infra/base infra/demo; do ( cd "$d" && npm ci >/dev/null 2>&1 && npx tsc --noEmit ); echo "$d exit=$?"; done
npm run up:base                  # 19 resources; the budget is skipped: Budgets is 501 here
npm run evidence:base            # public-subnets=2 private-subnets=2 subnet-azs=2 private-default-route=0 security-groups=3 tagged-resources=11
npm run evidence:iam             # sim-allowed=allowed sim-denied=explicitDeny (LocalStack's answer; AWS would say implicitDeny)
npm run evidence:localstack-iam  # deny-all=200 fake-key=200 oidc-forged-jwt=200 enforce-iam-log-lines=0
npm run preview:demo             # RDS Multi-AZ, ALB, Lambda target: 11 to create
npm run up:demo                  # 501 on RDS and ELBv2 — the expected answer on this lane
npm run destroy:demo && npm run destroy:base   # the six keys, all 0, also land in evidence/demos.txt
npm run localstack:down
```

`npm run demo:failover|demo:alb|demo:nat` stop at once on this lane (RDS and ELBv2 are 501, and
the emulator does not bill), see [AWS](#aws).

### Observability (the logs, metrics and traces homework)

No cloud account is needed. `package.json` is in the repository root, so there is no `cd`. The
grader has no store, so every *сховище* row of [Observability → Variables](#variables-4) and the
API's own store variables (database, signing key, storage) are exported directly. The Grafana
password goes first, because `observability/compose.yml` refuses to start without it. The
database and storage values are the compose dev credentials, which are not a secret. The signing
key is a throwaway ES256 pair generated on the spot (the application needs *a* valid pair, see
[the earlier homeworks](#the-earlier-homeworks)).

```bash
export SKIP_VAULT=1                                   # the grader has no access to the store
export GRAFANA_ADMIN_USER=admin                       # store variables → observability/compose.yml
export GRAFANA_ADMIN_PASSWORD=grader-grafana-password
docker compose up -d --wait postgres pgbouncer storage        # the API's own dependencies
docker compose -f observability/compose.yml up -d --wait      # Prometheus 22901, Grafana 22903, Jaeger 22904 + OTLP 22918

export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:22918     # Jaeger, OTLP over HTTP
export PROMETHEUS_URL=http://127.0.0.1:22901
export TRACE_API_URL=http://127.0.0.1:22904                   # Jaeger query API (/api/traces/<id>)
export DATABASE_URL=postgres://marketplace:marketplace_dev_password@127.0.0.1:56432/marketplace
export STORAGE_ENDPOINT=http://127.0.0.1:59000
export STORAGE_BUCKET=marketplace-files
export STORAGE_ACCESS_KEY=marketplace
export STORAGE_SECRET_KEY=marketplace_dev_storage_password
node -e 'const {generateKeyPairSync}=require("node:crypto");
const k=generateKeyPairSync("ec",{namedCurve:"P-256",
  privateKeyEncoding:{type:"pkcs8",format:"pem"},publicKeyEncoding:{type:"spki",format:"pem"}});
require("node:fs").writeFileSync("/tmp/hw29-keys.sh",
  "export JWT_PRIVATE_KEY="+Buffer.from(k.privateKey).toString("base64")+"\n"+
  "export JWT_PUBLIC_KEY="+Buffer.from(k.publicKey).toString("base64")+"\n");'
. /tmp/hw29-keys.sh
export JWT_KID=grader
export REFRESH_TOKEN_PEPPER=grader-pepper
npm ci

npx tsc --noEmit
npm run demo:logs      # non-json-lines=0 layers=4 distinct-trace-ids=1 trace-id-matches-header=1 burst=10 burst-trace-ids=10 burst-uneven=0 secret-req-logged=1 secret-in-logs=0
npm run demo:metrics   # sent-ok=52 sent-fail=8 counter-delta=60 errors-delta=8 above-top-bucket=0 series-before=5 series-after=5
npm run demo:trace     # spans=7 orphan-spans=0 trace-matches-header=1 trace-matches-log=1 span-status-error=1
```

Each demo builds first (`npm run build --silent && bash scripts/with-secrets.sh dev node demo/….mjs`).
It brings the schema up to date, resets its own accounts (`demo-logs-*`, `demo-metrics-*`,
`demo-trace-*@auth-demo.test`) and its product, starts `dist/main.js` on **22910** (the port
Prometheus scrapes), and stops it on the way out. Run them in any order, as many times as needed.
Port 22910 has to be free. `demo:logs` takes about 3 s, `demo:metrics` about 14 s (most of it
waiting for Prometheus to scrape the run, which is informational), and `demo:trace` about 4 s.

The dashboard is at `http://127.0.0.1:22903/d/marketplace-red`, logged in as the two Grafana
variables above. Jaeger's UI is at `http://127.0.0.1:22904`. To bring the stand down:
`docker compose -f observability/compose.yml down` (with the Grafana password still exported).

### Kubernetes (the rollout homework)

This needs no cloud account: one kind node on the local Docker is enough. It also needs neither
the compose stack nor the root `npm ci`, because the demos use only Node built-ins, `kubectl`,
`kind`, `pulumi`, `docker` and `curl`. `npm run scan` uses a local `trivy` if there is one, and the
`aquasec/trivy` image otherwise. The grader has no store, so the two store variables
(`DB_PASSWORD`, `PULUMI_CONFIG_PASSPHRASE`, the rows marked *сховище* in
[Kubernetes → Variables](#variables-3)) are exported directly:

```bash
export SKIP_VAULT=1                                  # the grader has no access to the store
export DB_PASSWORD=grader-secret                     # store variable → K8s Secret marketplace-api-secrets
# since the coursework the program also needs BROKER_PASSWORD, STORAGE_SECRET_KEY, JWT_PRIVATE_KEY,
# JWT_PUBLIC_KEY, JWT_KID, REFRESH_TOKEN_PEPPER, PAYMENT_WEBHOOK_SECRET — the export lines are in
# "Kubernetes: the full contour"
export PULUMI_BACKEND_URL="file://$PWD/.pulumi"      # local file backend, no pulumi login
export PULUMI_CONFIG_PASSPHRASE=hw28-grading         # store variable → encrypts the Pulumi state
npm --prefix infra ci
printf 'dummy-npm-token' > .npm_token                # build-stage secret; not in git
npm run image:build                                  # docker/Dockerfile -> marketplace-api:1.0.0
npm run cluster:up                                   # kind create + kind load docker-image
npm run up                                           # pulumi up

kubectl -n marketplace get pdb marketplace-api -o jsonpath='{.status.disruptionsAllowed}{"\n"}'   # 1, BEFORE demo:pdb
npm run demo:image     # stages=4 shell-inside=0 runtime-uid=65532 token-in-history=0 token-in-config=0 token-in-layers=0
SCAN_MAX=-1 npm run scan;    echo "exit=$?"     # gate=fail, exit=1
SCAN_MAX=99999 npm run scan; echo "exit=$?"     # gate=pass, exit=0
npm run demo:rollout   # profile=safe requests≈30000 ok=requests failed=0 rollout-seconds≈21, exit 0 (GET /products)
npm run demo:pdb       # healthy=3 minAvailable=2 evict-1=201 evict-2=429

npm run destroy && npm run cluster:down
```

The names used by the criteria are namespace `marketplace`, Deployment, Service, PDB and HPA
`marketplace-api`, and Secret `marketplace-api-secrets`. Criterion 5 runs `pulumi preview` inside
`infra/`; the stack `dev` is selected by `npm run up`. When Pulumi creates the stack it adds an
`encryptionsalt:` line to `infra/Pulumi.dev.yaml`. That salt comes from the passphrase, so it is
different for every person, and it is not committed.

Two optional runs. `PROFILE=broken npm run demo:rollout` gives failures and `exit 1`, then puts the
safe profile back. `LOAD_KEEPALIVE=0 npm run demo:rollout` opens a new connection for every
request, capped at 300/s (see [the rollout](#the-rollout) for why the cap exists). Each demo cleans
up after itself: the generator's file is deleted, and the cluster is left in the safe profile with
every pod ready. Run them in any order, as many times as needed.

### The earlier homeworks

The files homework and the auth homework share one preamble; the blocks after it are the earlier
homeworks and still apply. `package.json` is in the repository root, so there is no `cd`. The
object storage is RustFS from `docker-compose.yml` (S3 API on `59000`); its credentials below are
the compose dev values, which are not a secret. The signing key is **not** in this
README and the grader does not need it: the application only needs *a* valid ES256 pair, so the
block generates a throwaway one on the spot. The PEMs travel base64-encoded, because a multi-line
`export` does not survive every shell (`DECODER routines::unsupported` on the first signature).

```bash
docker compose up -d --wait
export DATABASE_URL=postgres://marketplace:marketplace_dev_password@127.0.0.1:56432/marketplace
export SKIP_VAULT=1    # the grader has no access to the secret store

# a throwaway ES256 (EC P-256) pair for this run; PEM goes base64 so newlines survive
node -e 'const {generateKeyPairSync}=require("node:crypto");
const k=generateKeyPairSync("ec",{namedCurve:"P-256",
  privateKeyEncoding:{type:"pkcs8",format:"pem"},
  publicKeyEncoding:{type:"spki",format:"pem"}});
const fs=require("node:fs");
fs.writeFileSync("/tmp/priv.b64",Buffer.from(k.privateKey).toString("base64"));
fs.writeFileSync("/tmp/pub.b64",Buffer.from(k.publicKey).toString("base64"));'
export JWT_KID=grader
export JWT_PRIVATE_KEY="$(cat /tmp/priv.b64)"
export JWT_PUBLIC_KEY="$(cat /tmp/pub.b64)"
export REFRESH_TOKEN_PEPPER=grader-pepper
export STORAGE_ENDPOINT=http://127.0.0.1:59000                    # RustFS from compose, S3 API
export STORAGE_ACCESS_KEY=marketplace
export STORAGE_SECRET_KEY=marketplace_dev_storage_password
export STORAGE_BUCKET=marketplace-files                           # created by the demos if missing
npm ci

npx tsc --noEmit
npm run demo:upload    # intent=200 key-from-server=1 api-alive=0 put-offline=200 commit=200 commit-without-bytes=409 tampered=403 expired=403
npm run demo:multipart # head-before-complete=404 resumed-parts=1 complete=200 size-match=1 etag-multipart=1
npm run demo:multipart # the same again: the demo cleans up before and after itself
npm run demo:cdn       # direct=403 edge-miss=200 edge-hit=200 cache-hit=1 new-name=1 new-url=200 content-changed=1

npm run demo:auth      # login=200 no-token=401 with-token=200 refresh=200 logout=204 after-logout=401 refresh-after-logout=401
npm run demo:reuse     # login=200 r1-refresh=200 r1-reuse=401 r2-after-reuse=401
npm run demo:rbac      # anon=401 own=200 foreign=403 role-denied=403 role-allowed=201 tampered=401
```

The three file demos build first like every other demo and go through
`bash scripts/with-secrets.sh dev …`. `demo:upload` and `demo:multipart` bring the schema up to date
(migration `1793351762427-Files`), reset their own account, its rows and everything under its
`uploads/<id>/` prefix (unfinished multipart uploads are aborted, objects deleted), and start the
API themselves on free ports. `demo:cdn` needs only the bucket: it deletes its own `assets/demo-app.*`
objects and starts the edge (`dist/edge.js`) on a free port. All of them stop their processes on the way
out. `demo:upload` takes about 6 s, because it waits for a 2-second URL to expire. Details and the
reasoning behind every number are in [Files](#files-файли).

The four variable names are `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `JWT_KID` and
`REFRESH_TOKEN_PEPPER` — the rows marked *secrets store* in the [Auth](#auth-автентифікація-та-авторизація)
table. Each demo builds first (`npm run build --silent && bash scripts/with-secrets.sh dev node
dist/demo-….js`), brings the schema up to date (migration `1793349700000-AuthRolesRefreshTokens`),
resets its own accounts (`demo-auth-*`, `demo-reuse-*`, `demo-rbac-*@auth-demo.test`, a fresh random
password every run), starts the real API — `dist/main.js`, the same entry point as `npm run start` —
on a free port, and kills it on the way out, also on Ctrl-C. No `migrate`, no `seed`, no port to
free, any order, any number of times. Exit code 0 only if every invariant held; the human-readable
checks are printed above the `key=value` lines.

`npm run start` stays a bare start: without the store variables it exits `1` and names each
of them, before Nest or the database pool is even imported:

```
$ env -u JWT_PRIVATE_KEY -u JWT_PUBLIC_KEY -u JWT_KID -u REFRESH_TOKEN_PEPPER -u STORAGE_SECRET_KEY npm run start; echo "exit=$?"
Startup aborted.
Invalid environment configuration — 5 problem(s):
  - JWT_PRIVATE_KEY: Required (not set)
  - JWT_PUBLIC_KEY: Required (not set)
  - JWT_KID: Required (not set)
  - REFRESH_TOKEN_PEPPER: Required (not set)
  - STORAGE_SECRET_KEY: Required (not set)
…
exit=1
```

The Redis homework, with the same `DATABASE_URL` and `SKIP_VAULT=1`:

```bash
export BROKER_URL=amqp://marketplace:marketplace_dev_password@127.0.0.1:5672
export REDIS_URL=redis://:redis_dev_password@127.0.0.1:56379        # the cache: allkeys-lru
export REDIS_QUEUE_URL=redis://:redis_dev_password@127.0.0.1:56380  # queue, sessions, limits: noeviction
npm run build          # the demos run from dist/

npx tsc --noEmit
npm run demo:cache     # cache-lru=1 cache-maxmemory=1 warmed=60 ttl-distinct≈40 concurrent=50 db-calls=1 db-calls-warm=0
npm run demo:session   # requests=4 sessions=1 in-redis=1 ttl-renewed=1
npm run demo:ratelimit # instances=2 limit=5 requests=20 allowed=5 blocked=15 status=429 retry-after=1
npm run demo:queue     # queue-noeviction=1 attempts=3 completed=1 added=2 queued=1 schedulers=1 scheduled-runs≈7

npm run demo:outbox      # requests=2 orders=1 outbox=1 published=1 deliveries=1 effect=1 processed=1
npm run demo:crash-write # write-failed=1 orders=0 outbox=0 published=0 deliveries=0 effect=0
npm run demo:crash-relay # published=2 deliveries=2 applied=1 effect=1 processed=1

npm run demo:publish   # published=5 delivered=5 effect=5 acked=5 dlq=0 prefetch=32
npm run demo:dlq       # rejected=1 work=0 dlq=1 dlq-reason=rejected effect=0
npm run demo:duplicate # deliveries=2 effect=1 skipped=1

bash scripts/with-secrets.sh dev bash scripts/backup.sh
bash scripts/with-secrets.sh dev bash scripts/restore-drill.sh
```

The four Redis demos build before they run, like the outbox demos below, and clean up after
themselves: every key they write is deleted at the end, the queue is obliterated before and after.
Only `demo:cache` needs Postgres (it creates its own seller and 60 products and brings the schema
up to date); the other three need nothing but the two Redis instances. `REDIS_URL` is the cache
on `56379`, `REDIS_QUEUE_URL` the queue instance on `56380` — compose publishes `56379:6379` and
`56380:6379`, and the password is the compose dev credential `redis_dev_password`. Details in
[Redis: cache, sessions, limits, queue](#redis-cache-sessions-limits-queue-redis-кеш-сесії-ліміти-черга).

The three outbox demos build before they run (`npm run build --silent && bash
scripts/with-secrets.sh dev node dist/…`), so they also work straight after `npm ci`. Like the
broker demos below, they bring the schema up to date (the outbox, inbox and key tables come
from migration `1792664108077-OutboxInboxIdempotencyKeys`), create their own buyer and product,
and clean up after their previous run. No `migrate` or `seed` is needed, and they run in any
order, any number of times. Details in
[Transactional outbox and idempotency](#transactional-outbox-and-idempotency-outbox-та-ідемпотентність).

`BROKER_URL` is AMQP on `5672` — compose publishes `5672:5672`; `15672` is the management UI
and does not speak the protocol (the code refuses that port with a message saying so). The
broker demos also need `DATABASE_URL`, because the effect they count lives in Postgres. They
bring the schema up to date and create their own buyer and product, so neither `migrate` nor
`seed` has to run first; details in
[Async events through RabbitMQ](#async-events-through-rabbitmq-async-події-через-rabbitmq).

Port `56432` is **PgBouncer**, which is where every client belongs from the pooling
homework on; compose publishes it with `56432:6432`, and Postgres itself stays on `55432`.
Those are the dev credentials from `docker-compose.yml`, and by the rules of the
configuration homework they are not a secret.

`SKIP_VAULT=1` makes `scripts/with-secrets.sh` hand the command straight through, so
`bash scripts/with-secrets.sh dev bash scripts/backup.sh` and a bare `bash scripts/backup.sh`
do exactly the same thing — both scripts read the connection from the environment. Without
those two exports a fresh clone fails loudly instead of connecting to something unexpected:
the bare form with `DATABASE_URL: unbound variable`, the wrapped form with a message naming
the missing store. Both exit `1`.

The same two exports cover everything from the earlier homeworks — `src/data-source.ts`
accepts `DATABASE_URL`, `DB_URL` + `DB_PASSWORD`, or the discrete `DB_HOST`/`DB_PORT`/
`DB_USER`/`DB_NAME` set. `package.json` is in the repository root, so no `cd` is needed:

```bash
npm ci && npx tsc --noEmit          # clean compile
npm run build                       # tsc → dist/, including dist/migrations/*.js
npm run migrate && npm run migrate:show
npm run migrate:revert && npm run migrate
npm run seed && npm run seed        # idempotent: same row counts twice
npm run demo:nplus1                 # query counts before/after
npm run report                      # aggregate through QueryBuilder

npm run demo:race                   # 50 parallel checkouts, stock 10 → exactly 10 orders
npm run demo:workers                # 4 workers, FOR UPDATE SKIP LOCKED, nothing processed twice
npm run demo:retry                  # 40001 caught, whole transaction retried, arithmetic intact
```

The testing homework needs only Docker running — no database setup, no `.env`, and the
compose stack does not have to be up, because `@testcontainers/postgresql` starts the
database from inside the run:

```bash
npm run test:integration            # 25 tests: repositories, status history, payments; real Postgres
npm run test:integration            # again: still green, nothing cleaned by hand
npm run test:e2e                    # 4 tests: create → read, 404 and 400
npm run test:contract               # writes pacts/marketplace-web-marketplace-api.json
npm run verify:provider             # the real app answers every interaction
```

For the contract gate the broker has to be up (`docker compose up -d --wait`) and the
address exported, which is not a secret when it is your own compose:

```bash
export PACT_BROKER_URL=http://127.0.0.1:9292
bash scripts/pact-gate.sh publish && npm run verify:provider
bash scripts/pact-gate.sh can-i-deploy      # deployable: null  → exit 1
bash scripts/pact-gate.sh tag-prod
bash scripts/pact-gate.sh can-i-deploy      # deployable: true  → exit 0
```

Both outputs, and why the order matters, are in [Testing](#testing-integration-end-to-end-contract).

The pooling homework adds three checks that need no npm script:

```bash
psql -h 127.0.0.1 -p 56432 -U marketplace -d marketplace -c "SELECT 1"
psql -h 127.0.0.1 -p 56432 -U marketplace -d pgbouncer   -c "SHOW POOLS"
pg_restore --list "$(ls -t backups/*.dump | head -1)" | head
```

`psql` prompts for the password, or takes it from `PGPASSWORD=marketplace_dev_password`.
`SHOW POOLS` lists `marketplace` with `pool_mode = transaction`; a pool appears only once
something has connected to it, so run the `SELECT 1` first.

The three demos need the schema and the fixtures, so `npm run migrate && npm run seed`
comes first; each of them then resets the rows it works on, which makes them repeatable in
any order and any number of times.

Without `SKIP_VAULT=1` the same commands take the normal route: each of them is wrapped in
`bash scripts/with-secrets.sh dev …` inside `package.json`, and the wrapper refuses to run
when the store is not there (`.env` is git-ignored), so a fresh clone fails loudly instead
of silently connecting to something else.

## Where the connection comes from

`src/data-source.ts` contains no host, no user and no password — it reads `process.env`
and nothing else:

```
secret store (.env + secrets/db_password)
        │  scripts/with-secrets.sh dev …
        ▼
process.env: DB_URL | DB_HOST/DB_PORT/DB_USER/DB_NAME, DB_PASSWORD | DB_PASSWORD_FILE
        ▼
DataSource({ type: 'postgres', …, synchronize: false })
```

Both shapes are accepted: `DB_URL` (what the app already uses, password kept out of the
URL) or the discrete `DB_*` variables (what CI and the grader export). The password comes
from `DB_PASSWORD`, or from the file named by `DB_PASSWORD_FILE` — the same rotatable file
the pool reads. If neither is set, the script fails with a message that names the two ways
to fix it instead of hanging on a connection attempt.

`scripts/with-secrets.sh` gained the two lines that make grading possible:

```bash
ENV_SLUG="${1:-dev}"; shift || true
[ "$#" -gt 0 ] || set -- npm run start

# the grader has no access to the store: the values are already in the environment
if [ "${SKIP_VAULT:-0}" = "1" ]; then exec "$@"; fi

CREDS="$ROOT/.env"
```

The order matters: the check sits *after* `shift`, so the slug has already been taken off
the argument list. Above `shift` it would `exec dev …` and every database command would die
with `exec: dev: not found`.

## Entities and relations

| Entity | Table | File |
| --- | --- | --- |
| `User` | `users` | `src/entities/user.entity.ts` |
| `Product` | `products` | `src/entities/product.entity.ts` |
| `Order` | `orders` | `src/entities/order.entity.ts` |
| `OrderItem` | `order_items` | `src/entities/order-item.entity.ts` |

Every column type, `NOT NULL`, `CHECK` and index of the SQL design is expressed in the
decorators, including the generated column that feeds full-text search:

```ts
@Column({
  type: 'tsvector',
  name: 'search_vector',
  generatedType: 'STORED',
  asExpression: "to_tsvector('simple', name || ' ' || description)",
  select: false,
  insert: false,
  update: false,
})
searchVector!: string;
```

Four foreign keys, four decisions:

| FK | Relation | `onDelete` | Why |
| --- | --- | --- | --- |
| `products.seller_id → users.id` | `Product.seller` / `User.products` | `RESTRICT` | a seller with a catalogue is not deletable; the catalogue is referenced by past orders |
| `orders.buyer_id → users.id` | `Order.buyer` / `User.orders` | `RESTRICT` | an order without a buyer is a hole in the financial history |
| `order_items.order_id → orders.id` | `OrderItem.order` / `Order.items` | `CASCADE` | a line has no meaning outside its order: the child follows the parent |
| `order_items.product_id → products.id` | `OrderItem.product` / `Product.orderItems` | `RESTRICT` | deleting a product must not erase what somebody bought; archiving is `status = 'archived'` |

The rule behind it: history is protected with `RESTRICT`, ownership is expressed with
`CASCADE`. Only `order_items` is owned by its parent, so only one FK cascades.

`order_items` is a many-to-many between orders and products that carries data — `qty` and
`unit_price_minor`, the price **at the moment of purchase**. That is exactly the case where
`@ManyToMany` is the wrong tool, so the join table is a first-class entity with its own
`@OneToMany`/`@ManyToOne` pair on each side and a `UNIQUE (order_id, product_id)`. There is
no `@OneToOne` in this schema: nothing here is a strict 1:1 extension of another row, and
inventing one to use the decorator would be worse than not using it.

## Migrations, and what was corrected by hand

```bash
npm run migrate:generate -- src/migrations/InitialSchema   # compares entities with the live DB
npm run build                                              # the generated .ts also needs compiling
```

`migration:generate` works off the compiled `dist/data-source.js` and off a **live**
database: run `npm run migrate` to the end first, change the entities only then, and
generate afterwards — otherwise you end up with two migrations describing the same tables
and the second one dies with `relation "…" already exists` (42P07).

Three things TypeORM cannot express in entity metadata, added to the generated migration by
hand and undone in `down()`:

```ts
await queryRunner.query(`CREATE INDEX "idx_orders_buyer_created_at" ON "orders" ("buyer_id", "created_at" DESC)`);
await queryRunner.query(`CREATE INDEX "idx_users_email_lower" ON "users" (lower(email))`);
await queryRunner.query(`CREATE INDEX "idx_products_search_vector" ON "products" USING GIN ("search_vector")`);
```

— the `DESC` half of the composite index (a `@Index` has no sort order), the expression
index that makes the case-insensitive e-mail lookup indexable, and the GIN access method
for the `tsvector`. The partial index survived generation as written, because `@Index`
does take a `where`:

```ts
@Index('idx_orders_refunded_created_at', ['createdAt'], { where: "status = 'refunded'" })
```

`down()` is real, not a stub — it drops the four indexes, the four foreign keys and the four
tables in reverse order, and removes the generated-column row TypeORM keeps in
`typeorm_metadata`:

```bash
npm run migrate:revert    # → Migration InitialSchema… has been reverted successfully
npm run migrate:show      # → [ ] InitialSchema…
npm run migrate           # → the schema is back
```

## Seed

`src/seed.ts` is fixture data written out in full — 8 users (4 sellers, 4 buyers), 12
products, 10 orders, 22 order lines, with fixed timestamps and prices. No randomness: two
runs on two machines produce the same rows.

Idempotency comes from natural keys rather than from `TRUNCATE`: a user is found by
`email`, a product by `(seller_id, name)`, an order by `(buyer_id, created_at)`, a line by
`(order_id, product_id)`. Found rows are updated to the fixture values, missing ones are
inserted, and the whole thing runs in one transaction. `id` columns are
`GENERATED ALWAYS AS IDENTITY`, so the seed never writes an id of its own.

```bash
npm run seed && npm run seed
```

```
seed done — rows per table (the same numbers on every run):
  users          8
  products      12
  orders        10
  order_items   22
```

The same check straight from the database:

```bash
docker compose exec -T postgres psql -U marketplace -d marketplace -c "
  SELECT 'users' AS t, count(*) FROM users
  UNION ALL SELECT 'products',    count(*) FROM products
  UNION ALL SELECT 'orders',      count(*) FROM orders
  UNION ALL SELECT 'order_items', count(*) FROM order_items
  ORDER BY 1;"
```

## N+1, measured

`src/demo-nplus1.ts` builds a `DataSource` with `logging: ['query']` and a `Logger` whose
only job is to count and print what goes over the wire (`src/db/query-count-logger.ts`).
It then loads the same thing three ways — the order list of a period, with its lines and
the product behind every line (`order → items → product`, two levels of relations):

```bash
npm run demo:nplus1
```

| Strategy | 5 orders / 11 lines | 10 orders / 22 lines |
| --- | ---: | ---: |
| naive — `find()` per order, then `find()` per line | **17** | **33** |
| `relations: { items: { product: true } }` | **1** | **1** |
| the same + `relationLoadStrategy: 'query'` | **4** | **4** |

The naive number is `1 + orders + lines`: it grows with the collection, which is the whole
disease — doubling the period doubles the round trips while the data stays the same size.
The join strategy is one query regardless of `N`. The query strategy is a small constant
too: the root query, one query per relation level, plus the id map TypeORM uses to stitch
the one-to-many back together.

The point of the demo is that none of this is visible in the code — all three variants read
like ordinary `find()` calls. It is visible only in the log, which is why the script prints
every statement of the first run (shortened here — the real log carries the full SELECT
lists):

```
  1  SELECT … FROM "orders" "Order" WHERE created_at BETWEEN $1 AND $2
  2  SELECT … FROM "order_items" "OrderItem" WHERE order_id = $1   -- ["1"]
  3  SELECT … FROM "products" "Product" WHERE id = $1              -- ["1"]
  4  SELECT … FROM "products" "Product" WHERE id = $1              -- ["11"]
  …
 17  SELECT … FROM "products" "Product" WHERE id = $1              -- ["5"]
```

## Repository or QueryBuilder

The line is the return type. `find` / `findOne` / `save` are for whole entities and their
relations — they hydrate objects, and the repository API can express every read the API
layer needs, including the eager loading above. As soon as the result is *not* an entity —
an aggregate, a `GROUP BY`, a row shape assembled from several tables — `find()` cannot
describe it at all, and that is where `createQueryBuilder().getRawMany()` starts: raw rows,
one query, no hydration. In this project that means the whole domain runs on repositories
and only reporting uses the builder, which also keeps the reporting SQL in one readable
place instead of spread over entity decorators.

## The report

`src/report.ts` answers "who earns how much" — revenue per seller over settled orders
(`paid`, `shipped`), which needs three joins and two aggregates and therefore cannot be a
`find()`:

```bash
npm run report
```

```
seller             cc orders units   revenue, UAH
-------------------------------------------------
Лідер Взуття       UA      4     5      15 295.00
Комфорт Шуз        UA      3     7       9 693.00
Практик Спорт      DE      5    13       7 187.00
Стиль Маркет       PL      3     4       5 796.00
-------------------------------------------------
total                           29      37 971.00
```

The script prints the SQL it generated above the table, so the `GROUP BY` and the join
order are visible. Two details that bite here: `SUM`/`COUNT` come back as **strings** (a
`bigint` would not fit a JS number), so they are converted explicitly, and money stays in
minor units until the last moment — the division by 100 happens in the formatter, not in
the query.

# Concurrency: checkout under a parallel burst

The ORM layer above answers "can the schema be expressed in code". This one answers the
harder question: what happens when the same endpoint is called fifty times at once. Three
scripts do the answering, and each of them verifies its own invariants and exits non-zero
if they break — the numbers below are from actual runs, and `npm run demo:race` is a test,
not a demonstration.

## The operation

`src/concurrency/checkout.ts` — one transaction, four writes, no read-modify-write in
JavaScript:

```
BEGIN
  UPDATE products SET stock = stock - $qty
   WHERE id = $product AND status = 'active' AND stock >= $qty RETURNING price_minor, …   ← 0 rows ⇒ out of stock
  UPDATE users    SET balance_minor = balance_minor - $total
   WHERE id = $buyer AND balance_minor >= $total RETURNING balance_minor                 ← 0 rows ⇒ insufficient funds
  INSERT INTO orders …                                                                    ← the order
  INSERT INTO order_items …                                                               ← its line
  INSERT INTO jobs (type, payload, order_id) VALUES ('order_receipt', …)                   ← post-processing, handled by the workers
COMMIT
```

Either all five statements land or none of them do: the rejections are thrown as a
`CheckoutRejected` error, which unwinds `dataSource.transaction()` and rolls the whole
thing back, and the caller gets a typed `{ ok: false, reason }` instead of an exception.
There is no path that inserts an order without its line, its job or its payment — and
`demo:race` checks exactly that, including `orders LEFT JOIN order_items IS NULL` over the
whole table.

The transaction lives on one connection because `dataSource.transaction(cb)` takes a query
runner from the pool and gives the callback an `EntityManager` bound to it. Raw SQL inside
it goes through that same manager, so `BEGIN` and `COMMIT` cannot end up on two different
sockets — which is what would happen with `pool.query('BEGIN')`.

One TypeORM detail that costs an hour if you meet it at runtime: for `UPDATE` and `DELETE`,
`manager.query()` returns `[rows, rowCount]`, not `rows`. `src/concurrency/sql.ts` asks the
query runner for the structured result instead, so `RETURNING` behaves the same for every
command.

## Atomic UPDATE, not SELECT … FOR UPDATE

Both shapes are correct here; I picked the atomic conditional `UPDATE … WHERE stock >= $qty
RETURNING`. It does the check and the lock in a single statement: Postgres takes the row
lock, re-evaluates `stock >= $qty` after waiting (`READ COMMITTED` re-checks the predicate
when the blocking transaction commits), and answers with either the updated row or zero
rows — and zero rows *is* the "out of stock" branch. `SELECT … FOR UPDATE` needs two
statements and a round trip in between, and the value it hands to the application is only
usable because the lock is still held; if anyone later moves the arithmetic outside the
lock's lifetime, the bug is silent. The conditional `UPDATE` has no such window to get
wrong, and the `CHECK (stock >= 0)` constraint added in the same migration is the second
line of defence: even a wrong query cannot persist a negative stock. `FOR UPDATE` earns its
place where several rows must be read, compared and then written — the queue below is that
case.

## Race: `npm run demo:race`

50 parallel `checkout()` calls (`Promise.all`, no application-side queue), one product,
`stock = 10`, one unit per call, four buyers whose balances are deliberately oversized so
that stock — and only stock — is the constraint:

```
attempts                 50
successful checkouts     10
declined: out_of_stock   40
unexpected errors        0
final stock              0
rows with negative stock 0
wall clock               117 ms
```

Nine invariants are then checked in SQL: successes equal the initial stock, final stock is
zero, no row has negative stock, every success wrote an order, a line and a job, no orphan
orders exist, and every buyer's balance equals `50 000 000 − successes × price` to the
kopiyka — the last one is the lost-update check, since thirteen concurrent transactions
debit the same buyer row.

Fifty parallel calls are fifty connections' worth of demand against a pool of 25
(`poolSize` is raised for the demo only); the rest wait in the pool queue, which changes
the wall clock and nothing else.

## Worker pool: `npm run demo:workers`

Four workers inside one process, each claiming one job per transaction and holding it for
the duration of the work:

```ts
manager.createQueryBuilder(Job, 'job')
  .setLock('pessimistic_write')   // FOR UPDATE
  .setOnLocked('skip_locked')     // SKIP LOCKED
  .where('job.status = :status', { status: 'pending' })
  .orderBy('job.id', 'ASC')
  .limit(1)
  .getOne();
```

which TypeORM emits as `… WHERE "job"."status" = $1 ORDER BY "job"."id" ASC LIMIT 1 FOR
UPDATE SKIP LOCKED`. The `UPDATE` that marks the job `done` (and bumps its `processed`
counter) commits with the same transaction, so a worker that dies before `COMMIT` loses its
lock and the job goes back to the pool instead of disappearing.

```
worker-1     6 jobs
worker-2     6 jobs
worker-3     6 jobs
worker-4     6 jobs

jobs enqueued            24
processed exactly once   24
processed twice          0
still pending            0
wall clock               377 ms
the same work sequential 960 ms (24 x 40 ms)
```

377 ms against 960 ms is the proof that `SKIP LOCKED` is doing what it says: without it the
four workers would queue behind the same row and the wall clock would land on the
sequential number. An empty result from a `SKIP LOCKED` query means "nothing is free right
now", not "the queue is empty", so a worker only stops after three empty polls in a row —
the count of those polls is printed next to each worker.

## Retry: `npm run demo:retry`

Eight transactions under `REPEATABLE READ` do the thing the checkout deliberately avoids:
`SELECT balance_minor`, arithmetic in JavaScript, `UPDATE` without a lock. A barrier makes
all eight read before any of them writes, so the conflict is guaranteed rather than lucky.

```
  writer- 6  attempt 6 hit 40001, retrying the whole transaction in 202 ms
            could not serialize access due to concurrent update

serialization failures caught  24
  40001  24
balance before                 5000000
balance after                  4920000
expected                       4920000 (5000000 - 8 x 10000)
wall clock                     658 ms
```

Twenty-four retries in this run (the number moves between runs — it is a race), every one
of them `40001`, and the final balance is exactly `8 × 10 000` below the start: no update
was lost. That last part only works because the wrapper in `src/concurrency/retry.ts`
retries the **whole** transaction, re-reading the balance on every attempt. Retrying only
the `UPDATE` would replay the arithmetic from a stale snapshot, which is the lost update it
was supposed to prevent.

The wrapper retries exactly two SQLSTATEs and nothing else:

```ts
export const RETRYABLE_SQL_STATES = new Set(['40001', '40P01']);
```

`40001` (`serialization_failure`) and `40P01` (`deadlock_detected`) are the two codes that
mean *"your transaction is fine, the timing was not"* — Postgres rolled it back to protect
a guarantee, and the same statements replayed against a fresh snapshot are expected to
succeed. Everything else is a statement about the transaction itself: `23505` is a duplicate
key, `23514` a violated `CHECK`, `22003` an overflow, `42P01` a typo in a table name. Those
do not become true on the second attempt — retrying them burns the database's time and,
worse, hides a bug behind a slow endpoint. A blanket `catch` plus retry is how a unique-key
violation turns into a production mystery.

## What the schema gained

Migration `StockBalanceAndJobQueue`:

| Change | Why |
| --- | --- |
| `products.stock integer NOT NULL DEFAULT 0` + `CHECK (stock >= 0)` | the resource the race fights over, with the database as backstop |
| `users.balance_minor integer NOT NULL DEFAULT 0` + `CHECK (balance_minor >= 0)` | payment in the same minor units as prices |
| table `jobs` + partial index `WHERE status = 'pending'` | the queue; the index keeps the claim query off the done rows |
| `jobs.order_id → orders.id ON DELETE CASCADE` | a receipt job has no meaning without its order |

The generated migration needed reading again: TypeORM cannot see the `USING GIN` access
method of `idx_products_search_vector`, decided the index had drifted, and put a
`DROP INDEX` at the top of `up()` and a B-tree `CREATE INDEX` in `down()`. Both lines are
deleted — the index is created by the initial migration and stays untouched, which
`pg_indexes` confirms after `migrate`:

```
CREATE INDEX idx_products_search_vector ON public.products USING gin (search_vector)
```

## Where this is wired in (and where it is not)

`checkout()` is the data-layer operation, exercised by `demo:race`. The HTTP `POST /orders`
still runs the in-memory `OrdersService` from the contract homework: its request shape
(`items[]`, `Idempotency-Key` replay) belongs to the published OpenAPI contract, and
rewiring it is a contract change, not a concurrency one. Integration tests over `checkout()`
come with the testcontainers homework, and the `jobs` table is the first step towards the
transactional outbox later in the course.

# Data layer ops: pooling, backup, restore

Three things a database grows once it stops being a development toy: something in
front of it that survives many application instances, a dump taken on a schedule,
and proof that the dump is a database and not a file.

```
API / migrations / psql / pg_dump
        │
        ▼  127.0.0.1:56432          ← everything connects here
   PgBouncer  (transaction pooling, pool of 8)
        │
        ▼  postgres:5432            ← 55432 on the host, for admin work only
   Postgres 16
        │
        ▼  scripts/backup.sh (nightly, backup.cron)
   backups/marketplace-<date>.dump  +  .checksum sidecar
        │
        ▼  scripts/restore-drill.sh
   throwaway container on an empty volume → MATCH
```

## Bringing it up

```bash
docker compose up -d --wait
PGPASSWORD=marketplace_dev_password psql -h 127.0.0.1 -p 56432 -U marketplace -d marketplace -c "SELECT 1"
```

Compose publishes PgBouncer on `56432:6432` and waits for both health checks, so a
single command leaves a stack that is actually ready. `.env.example` and `.env` point
`DB_URL` at `56432`: the application has no route to Postgres that does not go through
the pooler, which is the only way the arrangement stays honest.

Admin console, the same way the lecture uses it:

```bash
PGPASSWORD=marketplace_dev_password psql -h 127.0.0.1 -p 56432 -U marketplace -d pgbouncer -c "SHOW POOLS"
```

```
  database   |    user     | cl_active | sv_idle | ... |  pool_mode
-------------+-------------+-----------+---------+-----+-------------
 marketplace | marketplace |         0 |       1 | ... | transaction
 marketplace_session | marketplace |   0 |       1 | ... | session
 pgbouncer   | pgbouncer   |         1 |       0 | ... | statement
```

A pool shows up only after something has connected to it, so `SHOW POOLS` on a
freshly started stack is emptier than expected — run the `SELECT 1` first.

## Why transaction mode, and what it breaks

`pool_mode = transaction` means a server connection is lent to a client for the
length of one transaction and taken back at `COMMIT`. That is what makes the
arithmetic work: `default_pool_size = 8` server connections serve
`max_client_conn = 200` clients, because at any instant only the clients inside a
transaction need one. Session pooling would pin a backend per connected client and
buy nothing over `pg.Pool`; statement pooling would break multi-statement
transactions, which is the entire concurrency homework. Transaction mode is the
setting that lets instance count grow in Kubernetes without Postgres growing
`max_connections` to match.

The price is that **nothing may outlive a transaction**, because the next statement
can land on a different backend and `server_reset_query = DISCARD ALL` wipes what
the last one left:

1. **Session-level `SET` is gone.** `SET statement_timeout`, `SET search_path`,
   `SET TIME ZONE` issued outside a transaction apply to whichever backend happened
   to serve them, and then to nobody. Only `SET LOCAL` inside the transaction is
   safe. This is also why `ignore_startup_parameters` has to list the options the
   client sends at connection time — PgBouncer cannot promise them.
2. **Named prepared statements break.** `PREPARE` on one backend, `EXECUTE` on
   another, and Postgres answers `prepared statement "s1" does not exist`. PgBouncer
   1.21+ tracks and replays them itself, which is why `max_prepared_statements = 200`
   is set here — without it the TypeORM/`pg` driver would have to be told to stop
   using them.
3. **Session-scoped locks and `LISTEN`/`NOTIFY` stop working.** `pg_advisory_lock()`
   without a transaction never sees the same backend again, so the lock is taken on
   a connection nobody holds and released by `DISCARD ALL` at an arbitrary moment.
   A listener registers on a backend it will not get back. The transaction-scoped
   variant `pg_advisory_xact_lock()` is fine — it dies with the transaction, which
   is exactly the lifetime the pooler guarantees.
4. **Temporary tables and `WITH HOLD` cursors do not survive.** A temp table created
   in one transaction is on a backend the next transaction may not get, and
   `DISCARD ALL` drops it regardless.

This project survives all four because everything it does to the database is already
transaction-shaped: `checkout()` is one explicit transaction, the worker pool takes
`FOR UPDATE SKIP LOCKED` row locks inside a transaction rather than advisory locks,
and the retry wrapper re-runs whole transactions. `npm run demo:race`,
`demo:workers` and `demo:retry` pass unchanged through the pooler — which is the
real test, not a `SELECT 1`.

The one tool that genuinely needs a session is `pg_dump`: it sets session options,
then holds a repeatable-read snapshot across the whole dump. Rather than lowering
`pool_mode` for everyone, `pgbouncer.ini` publishes the same database twice:

```ini
marketplace         = host=postgres port=5432 dbname=marketplace
marketplace_session = host=postgres port=5432 dbname=marketplace pool_mode=session
```

`scripts/backup.sh` probes for the `_session` alias and uses it when it is there,
falling back to the configured database when it is not — so the same script works
against a direct Postgres URL with no flags to remember.

## Backup

```bash
bash scripts/with-secrets.sh dev bash scripts/backup.sh
```

```
backup: /…/backups/marketplace-2026-09-30_214417.dump
size:   20K
order_items checksum (count|sum of qty * unit_price_minor): 22|4556700
```

`pg_dump --format=custom --compress=9` into `backups/marketplace-<YYYY-MM-DD_HHMMSS>.dump`
— custom format because it is the one `pg_restore` can be selective about and the one
that carries a TOC:

```bash
pg_restore --list backups/marketplace-2026-09-30_214417.dump | head
```

Next to each dump the script writes a `.checksum` sidecar holding the control value of
the data **at dump time**. That is what makes the drill meaningful: the live database
keeps moving, so comparing a restore against it would fail for the most ordinary
reason there is. Dumps older than `RETAIN_DAYS` (14) are deleted at the end of each
run, so the destination does not quietly fill the disk.

The destination is a local directory outside the container — `backups/`, git-ignored,
overridable with `BACKUP_DIR`. S3 is lecture #26; the script's only assumption about
the destination is that it is a path, which is what keeps that migration small.

### Schedule

`backup.cron` holds the line, and the line is the RPO:

```cron
15 3 * * * cd $MARKETPLACE_HOME && bash scripts/with-secrets.sh prod bash scripts/backup.sh >> /var/log/marketplace/backup.log 2>&1
45 4 * * 0 cd $MARKETPLACE_HOME && bash scripts/with-secrets.sh prod bash scripts/restore-drill.sh >> /var/log/marketplace/restore-drill.log 2>&1
```

One dump a night at 03:15 means up to 24 hours of writes are at risk, and the weekly
drill is there because a backup is only as good as the last restore somebody proved.

## Restore drill

```bash
bash scripts/with-secrets.sh dev bash scripts/restore-drill.sh
```

```
dump:     /…/backups/marketplace-2026-09-30_214417.dump (20K)
expected: 22|4556700  (recorded when the dump was taken)
1/4  empty volume marketplace-restore-drill-1790793857-83477 and a fresh postgres:18-alpine container
2/4  waiting for it to accept connections on 127.0.0.1:64193
3/4  pg_restore --no-owner into the empty database
4/4  reading the same control value back out of the restored database

order_items before: 22|4556700
order_items after:  22|4556700
pg_restore: 0.1s    drill end to end (measured RTO): 1.7s

MATCH
```

What makes it a drill rather than a demo:

- **The volume did not exist a second ago.** `docker volume create
  marketplace-restore-drill-<timestamp>-<pid>`, removed by an `EXIT` trap together
  with the container. Restoring into a volume that already holds data is where the
  fake `duplicate key` failures come from, and a `MATCH` there would mean nothing.
- **It cleans up after itself**, so a second run gives the same answer as the first.
- **`--no-owner --no-acl`** because the throwaway instance has never heard of the
  `marketplace` role, and `--exit-on-error` so a partial restore is a failure rather
  than a warning scrolling past.
- **It can fail.** Corrupt the sidecar and it prints `MISMATCH` and exits `1`.
- **The container's Postgres major version follows the client tools** that made the
  dump. A custom archive is only readable by its own `pg_restore` or a newer one, and
  a newer `pg_restore` emits `SET` options an older server rejects — a PG 18 client
  dumping a PG 16 server and restoring into PG 16 dies on `unrecognized configuration
  parameter "transaction_timeout"`. `DRILL_IMAGE` overrides it.

The numbers from the run above, plus the RTO and RPO they add up to, are written down
in [RESTORE-DRILL.md](RESTORE-DRILL.md).

# Testing: integration, end to end, contract

Three suites, each buying a different kind of confidence, and none of them mocking the
thing it is supposed to be testing.

| Command | What runs | Against what |
| --- | --- | --- |
| `npm run test:integration` | repositories, status history, payment webhooks — 25 tests | a real Postgres started by the test run |
| `npm run test:e2e` | the whole HTTP application, 4 tests | the real module graph, the real database |
| `npm run test:contract` | the consumer side of the contract | Pact's mock provider → `pacts/*.json` |
| `npm run verify:provider` | the real application answering the contract | the local pact file, or the broker |

```bash
npm ci
npm run test:integration && npm run test:e2e
npm run test:contract && npm run verify:provider
```

Docker has to be running — nothing else has to be. No database is set up by hand, no
`.env` is needed, and the compose stack does not have to be up: `@testcontainers/postgresql`
starts `postgres:16-alpine` from `test/testkit/global-setup.ts`, runs the project's own
migrations into it, and hands the connection string to the workers. The container is
stopped in `global-teardown.ts`. `DATABASE_URL` in the tests is therefore not a secret and
not a store value — it does not exist until the run creates it, which is the whole point of
this layer.

`maxWorkers: 1` is deliberate: every jest worker would otherwise multiply containers.

## `reporters: ['default']`

One line in `jest.config.js`, and not decoration. With `reporters` unset, Jest 30 picks a
reporter from the environment, and the compact one it selects in some runners prints no
`PASS <file>`, no `describe`/`it` names and no `✓` — only the final `Tests: N passed`. In a
plain terminal the full output is there either way, but the suite has to read the same
wherever it is run from.

## Isolation: transaction, then ROLLBACK

Every integration test runs inside a transaction that is rolled back when it ends
(`test/testkit/rollback.ts`). It is the cheapest of the three strategies — no `TRUNCATE`
between tests, one container for the whole run instead of one per file — and it is the only
one that makes the suite green on a second run with no cleanup step in between, because
nothing is ever committed. The cost is that a test cannot exercise code that commits by
itself, and that a statement which violates a constraint poisons the transaction it runs in;
the constraint tests therefore take a `SAVEPOINT` first and roll back to it, which is what
`ctx.attempt()` does. That is also why the repositories take *anything with `query()`*
rather than a `Pool` of their own: in production they are handed the pool, in tests the one
client the transaction is open on, and inside `checkout()` the connection the TypeORM
transaction already owns.

One test does need two real connections: the race of two transitions out of one status in
`order-history.test.ts`. A single rolled-back transaction cannot race itself, so that test
commits its order and deletes it (and its outbox rows) in `afterAll`.

```bash
npm run test:integration && npm run test:integration   # both green, nothing cleaned by hand
```

## Test data builders

`test/testkit/builders.ts` gives `aUser()`, `aProduct()` and `anOrder()`, each with valid,
unique defaults, so a test names only what it is actually about:

```ts
const seller = await aUser().create(ctx.db());
const product = await aProduct().soldBy(seller).named('Ноутбук Vela 14').create(ctx.db());
await anOrder().placedBy(buyer).withStatus('paid').withLine(product, 3).create(ctx.db());
```

Emails and names carry a unique suffix, so the `users_email_unique` index never fires by
accident — only where a test means it to.

## What the integration suite tests that a mock cannot

`ProductsRepository` and `OrdersRepository` are the data access the application actually
uses: `ProductsService` is built on the first, and `checkout()` from the concurrency
homework writes its order and its line through the second.

| Test | Why a mock would have missed it |
| --- | --- |
| product round-trip | `price_minor` comes back an integer, `created_at` a real `Date` |
| unknown seller → `23503` | the foreign key is in the database, not in the code |
| search by a word | `search_vector` is a **generated** tsvector column: `'ноут'` finds nothing, `'ноутбук'` does — a `LIKE '%…%'` mock would have matched both |
| paging | ordering and `OFFSET` are the database's behaviour |
| order read back with its lines | the product name lives only in `products`; only the JOIN knows it |
| same product twice in one order → `23505` | `order_items_order_product_unique` |
| revenue per seller | three-table `JOIN`, two aggregates, a `GROUP BY` and a status filter |
| deleting an order | `ON DELETE CASCADE` takes the lines with it |

The coursework added the order's lifecycle and its payments: `transition()` and
`recordStatus()` in `src/orders/lifecycle.ts`, `applyPayment()` in
`src/payments/apply-payment.ts` — plain SQL on whatever connection the caller's transaction
is open on, so the tests hand them the rolled-back one.

| Test (`order-history.test.ts`, `payments.test.ts`) | Why a mock would have missed it |
| --- | --- |
| transition writes row + history + outbox event | three tables in one transaction; the event carries the history row's id |
| a transition the table forbids | the refusal is the `UPDATE … WHERE old.status = ANY(…)` matching nothing — no history, no outbox |
| replay after a `Last-Event-ID` | `id > $2 ORDER BY id` over an identity column |
| two concurrent transitions out of one status | the row lock in the sub-select: exactly one wins, the loser reads the winner's status |
| history goes with a deleted order | `ON DELETE CASCADE` |
| webhook pays a confirmed or a pending order | intent, journal, status and history change together |
| redelivery of the same event | `ON CONFLICT (provider_event_id) DO NOTHING` — the state after the second call equals the state after the first |
| wrong amount, wrong currency | compared with `payment_intents`, frozen at checkout; journaled, order unmoved |
| failed payment, then a retry | intent `failed`, then `succeeded`; the order stays payable in between |
| money for a cancelled order | journaled as `ignored`, the order does not move |
| deleting an order with payment events → `23503` | `ON DELETE RESTRICT` keeps the journal |
| an unknown verdict → `23514` | `payment_events_verdict_known` |

## End to end

`test/e2e/products.e2e.test.ts` builds the application from `AppModule` with
`Test.createTestingModule({ imports: [AppModule] })` — **no `overrideProvider` anywhere** —
and then runs it through `configureApp()`, the same function `main.ts` calls. That matters:
request and response validation against `openapi/openapi.yaml` lives in there, so the suite
is testing the application that ships and not a leaner one.

- happy path: `POST /products` → `201`, then `GET /products/{id}` returns the same resource,
  and it is in `GET /products` too;
- the same `Idempotency-Key` replays instead of creating a second product;
- `GET /products/p_999999999` → `404 application/problem+json`;
- `POST /products` without the required header, and with an invalid body → `400`.

## Contract

The consumer test (`test/contract/consumer.pact.test.ts`) plays an imagined storefront
against Pact's mock provider and writes `pacts/marketplace-web-marketplace-api.json`. Two
interactions, each with a provider state, each on a path that exists in the spec from the
contract homework — `/products/p_1` and `/products/p_999999999` both answer to
`/products/{productId}`:

```bash
node -e 'const p=require("./pacts/marketplace-web-marketplace-api.json");const spec=require("fs").readFileSync("openapi/openapi.yaml","utf8");const sp=[...spec.matchAll(/^\s+(\/\S*):\s*$/gm)].map(m=>m[1]);const seg=s=>s.split("?")[0].replace(/\/+$/,"").split("/");const fit=(a,b)=>{a=seg(a);b=seg(b);return a.length===b.length&&a.every((x,i)=>/^\{[^}]+\}$/.test(x)?b[i]!=="":x===b[i])};const bad=p.interactions.filter(i=>!sp.some(x=>fit(x,i.request.path)));console.log(bad.length?"NOT IN THE SPEC: "+bad.map(i=>i.request.path).join(", "):"OK");process.exit(bad.length?1:0)'
# OK
```

Bodies are matched by type (`MatchersV3.like`, `integer`, `regex`), not by value, so a new
price in the catalogue does not break the contract.

`npm run verify:provider` then starts the **real** application against a testcontainer and
replays both interactions at it. The provider states seed the database with
`INSERT … ON CONFLICT DO NOTHING`, so the verification is repeatable:

```
  a request for the product page of p_1 (4ms loading, 15ms verification)
     Given a product with id p_1 exists
    returns a response which
      has status code 200 (OK)
      includes headers
        "Content-Type" with value "application/json; charset=utf-8" (OK)
      has a matching body (OK)
```

`pacts/*.json` is committed: `verify:provider` then works on a bare clone in whatever order
the commands are run, and the file is regenerated by `npm run test:contract` anyway.

## The broker, and the gate

`docker compose up -d --wait` brings up `pact-broker` on **9292** (with its own Postgres)
next to the application's database. It is deliberately open — it holds nothing but the
contract this repository generates, and a token in `docker-compose.yml` would be a constant
in git, not a secret. A real broker is reached with `PACT_BROKER_URL` and
`PACT_BROKER_TOKEN`, which the code only ever reads from `process.env`: locally they come
from the store of the configuration homework through the usual wrapper, in CI from GitHub
secrets.

```bash
bash scripts/with-secrets.sh dev npm run verify:provider    # the normal route
PACT_BROKER_URL=http://127.0.0.1:9292 npm run verify:provider  # no store at hand (grading, CI)
```

Both are legitimate. The first reads `PACT_BROKER_URL` out of `.env`; the second is the
emergency entrance — under `SKIP_VAULT=1` the wrapper simply executes the second form. With
no broker configured at all, the verification runs against the local pact file.

The gate itself, end to end. `scripts/pact-gate.sh` is a thin wrapper over the broker's HTTP
API so that CI and this README run the same four commands:

```bash
docker compose up -d --wait                       # broker healthy on 9292
export PACT_BROKER_URL=http://127.0.0.1:9292

bash scripts/pact-gate.sh publish                 # → HTTP 201
npm run verify:provider                           # → exit 0, result published to the broker
bash scripts/pact-gate.sh can-i-deploy            # → deployable: null, exit 1  ← the gate is shut
bash scripts/pact-gate.sh tag-prod                # → HTTP 201
bash scripts/pact-gate.sh can-i-deploy            # → deployable: true, exit 0  ← and now it is open
```

**Before the `prod` tag** — captured at commit `a6aaa08`, whose short sha is the version
both participants are published under. The provider version running in prod is not known,
so the only honest answer is "unknown":

```json
{
    "deployable": null,
    "reason": "There is no verified pact between version a6aaa08 of marketplace-web and the latest version of marketplace-api with tag prod (no such version exists)",
    "success": 0,
    "failed": 0,
    "unknown": 1
}
```

**After the `prod` tag** on the *same provider version* the verification was published
under:

```json
{
    "deployable": true,
    "reason": "All required verification results are published and successful",
    "success": 1,
    "failed": 0,
    "unknown": 0
}
```

That pair is the proof the gate is real rather than always-green. `can-i-deploy` exits `1`
whenever `deployable` is anything but `true` — asking about an environment nothing is tagged
for shows it without having to break the contract first:

```bash
PACT_ENVIRONMENT=staging bash scripts/pact-gate.sh can-i-deploy
# can-i-deploy says no: There is no verified pact … with tag staging (no such version exists)
# exit=1
```

The tag has to go on the **provider** version, and on the same `providerVersion` the
verifier published under — `test/contract/provider-version.ts` and `scripts/pact-gate.sh`
both derive it from `git rev-parse --short HEAD`, or from `PACT_PROVIDER_VERSION` when it is
set, which is what CI does with `github.sha`.

## CI

`.github/workflows/contract.yml` (since HW-32 a reusable workflow that `gates.yml` calls on every
PR, see [CI/CD](#cicd)) runs one job, `contract`: compile → integration → e2e →
consumer contract → **publish** → **provider verification** (with
`publishVerificationResult: true`) → record the provider version as what is in prod →
**can-i-deploy**, which fails the job when the answer is not `true`. The broker comes from
compose unless `secrets.PACT_BROKER_URL` names a hosted one.

# Realtime: WebSocket rooms and SSE

The order status already changed transactionally — the buyer just did not know
until they reloaded. This section pushes that change to a connected client the
moment it happens, over two transports, off **one** bus.

```
PATCH /orders/:id/status
        │
        ▼
OrdersService.setStatus()            ← the business operation, not the controller
        │
        ▼
OrderEventsService.publish()         ← Subject + a 100-event buffer per order
        │
        ├──────────────► OrdersGateway      server.to('orders:<id>').emit('order.status')
        └──────────────► GET /orders/:id/events   id: / event: / data: frames
```

`src/realtime/order-events.service.ts` is deliberately the only thing that knows
event numbers exist. The gateway is one subscriber, the SSE controller is another,
and neither imports the other. When lecture 19 puts *order placed* on RabbitMQ, the
queue consumer calls `publish()` and both transports light up with no further change.

## Bringing it up, and the two demo runs

```bash
docker compose up -d --wait
npm run build
npm run migrate && npm run seed
npm run start:vault                  # http://localhost:3000, WebSocket on the same port
```

Then, in a second shell:

```bash
npm run demo:realtime                # or: node scripts/realtime-demo.mjs
npm run demo:realtime:same-room      # or: node scripts/realtime-demo.mjs --same-room
```

The main run puts one client in `orders:A` and the other in `orders:B`, changes the
status of A over HTTP, and expects `A_RECEIVED=1 B_RECEIVED=0`. The control run puts
**both** clients in `orders:A` and expects `A_RECEIVED=1 B_RECEIVED=1`. The difference
between them is the proof: one code path, two outcomes.

```
node scripts/realtime-demo.mjs;             echo "exit=$?"
MODE=different-rooms
A_RECEIVED=1
B_RECEIVED=0
exit=0

node scripts/realtime-demo.mjs --same-room; echo "exit=$?"
MODE=same-room
A_RECEIVED=1
B_RECEIVED=1
exit=0
```

Exactly one line of the script decides both the room and the expectation, so a
script that printed a constant would fail one of the two runs:

```js
const roomB = SAME_ROOM ? orderA : orderB;
const expectedB = SAME_ROOM ? 1 : 0;
```

The script also asserts the room guard on the way through and prints
`GUARD_ANONYMOUS_REFUSED=1` / `GUARD_FOREIGN_REFUSED=1`: an anonymous socket and a
socket claiming a different user are both refused the room, with a reason in the
ack. It joins only after the `join` ack has arrived — emit into a room the client
has not entered yet and the event is lost with no error anywhere.

## Who may listen

*Updated by the auth homework.* `POST /orders` records the `sub` of the caller's
access token as the order's `buyer_id`; the `X-User-Id` header is gone, and so are
anonymous, public orders. `src/realtime/order-access.ts` is the one rule every
transport applies — HTTP, SSE and the WebSocket room:

| Order | Listener | Result |
| --- | --- | --- |
| `buyer_id: "40"` | token of user 40 | joins `orders:<id>` / streams |
| `buyer_id: "40"` | token of user 41 | refused — `forbidden` (HTTP 403) |
| `buyer_id: "40"` | admin's token | joins / streams |
| any | no token, or an invalid one | refused — `anonymous` (HTTP 401) |

WebSocket identity comes from the handshake (`io(url, { auth: { token } })`) and is
verified on every `join`; SSE takes `Authorization: Bearer …`. A browser `EventSource`
cannot set that header, so it is read with a fetch-based SSE client — a token in the
query string would end up in access logs. The realtime demo logs in as two seeded
buyers (`olena.kovalenko@…` owns both orders, `andrii.shevchenko@…` is the intruder);
details in [Auth](#auth-автентифікація-та-авторизація).

## The SSE side by hand

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"olena.kovalenko@example.com","password":"marketplace-dev-password"}' \
  | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')

ORDER=$(curl -s -X POST http://localhost:3000/orders -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: readme-$(date +%s)" \
  -d '{"items":[{"product_id":"p_1","qty":2}]}' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')

curl -sN --max-time 2 -D - -o /dev/null -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/orders/$ORDER/events | grep -i '^content-type'
# Content-Type: text/event-stream

curl -sN --max-time 5 -H "Authorization: Bearer $TOKEN" http://localhost:3000/orders/$ORDER/events &
curl -s -X PATCH http://localhost:3000/orders/$ORDER/status -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"status":"paid"}'
```

```
retry: 1000

id: 1
event: order.status
data: {"id":1,"order_id":"o_1","status":"paid","previous_status":"created","changed_at":"2026-09-30T19:32:00.318Z"}
```

`retry: 1000` is the first thing written after the headers: it sets the client's
reconnect delay to a second instead of the multi-second default, which is the
difference between a demo that reconnects visibly and one that looks hung.

### Last-Event-ID: a reconnect that loses nothing

Every event carries the next number in that order's sequence, and the last 100 stay
in memory. A client that reconnects with `Last-Event-ID: N` is sent everything
numbered above `N` before the stream goes live:

```bash
for s in paid cancelled paid created; do
  curl -s -o /dev/null -X PATCH http://localhost:3000/orders/$ORDER/status \
    -H 'Content-Type: application/json' -d "{\"status\":\"$s\"}"
done

curl -sN --max-time 2 -H 'Last-Event-ID: 3' http://localhost:3000/orders/$ORDER/events | grep '^id:' | head -1
# id: 4
```

The buffer is read and the live subscription filtered in the same synchronous step
(`concat(from(replay), live.pipe(filter(id > delivered)))`), so the seam produces
neither a gap nor a duplicate.

No header at all is treated as `Last-Event-ID: 0` — *I hold nothing, send everything
you still have* — so a client that connects after the interesting change already
happened is caught up on the current status instead of waiting for the next one. It is
the same code path with `N = 0`, not a second one.

## Trade-offs: WebSocket vs SSE

Both transports carry the identical event here, which is what makes comparing them
honest — the difference is in the plumbing, not the payload.

| Criterion | WebSocket (socket.io) | SSE (`text/event-stream`) |
| --- | --- | --- |
| Channel direction | full duplex — the client's `join` is a message on the same socket | server → client only; anything upstream needs a separate HTTP request |
| Reconnect / recovery | socket.io reconnects with backoff, but rejoining rooms and replaying misses is application code | reconnect is in the browser, `Last-Event-ID` is in the protocol, and the server replays from its buffer |
| Infrastructure | needs an upgrade hop through every proxy, sticky sessions or a Redis adapter for more than one instance, and a socket.io client on the page | ordinary HTTP/2 GET, no upgrade, no client library at all; needs response buffering off (`X-Accel-Buffering: no`) |
| Cost per event | one small frame, no headers, negligible; the connection itself is the fixed cost | same frame plus SSE's text framing, but one long-lived response instead of a protocol upgrade |
| Fan-out shape | rooms and namespaces come for free — `server.to(room).emit()` | one subscription per open request; grouping is the application's own bookkeeping |
| Browser ceiling | one connection, multiplexed | ~6 per origin on HTTP/1.1 (fine on HTTP/2) |

For notifications in production I would keep **SSE**. The traffic here is one-way —
the server tells the buyer their order changed — and paying for a duplex upgrade to
use half of it buys nothing, while `Last-Event-ID` gives the one property that
actually matters for a notification (a reconnect that does not silently lose events)
in the protocol rather than in code I have to get right. The WebSocket gateway earns
its place the moment the client starts talking back on the same channel — live chat
with a seller, or presence — and that is exactly what this homework built both for:
the bus does not care which one is attached.

## Two instances, and what breaks

A `Subject` and a room registry live in one process, so with two instances behind a
load balancer a client connected to instance 1 hears nothing about a status change
handled by instance 2 — the cure is `@socket.io/redis-adapter` (plus `app.useWebSocketAdapter`),
which turns `to(room).emit()` into a Redis publish every instance replays, and for SSE
the same Redis (or the RabbitMQ fan-out of lecture 19) feeding each instance's bus.

# Async events through RabbitMQ (Async-події через RabbitMQ)

The realtime feature delivers to whoever is connected *now*; nobody connected, nothing
delivered. This section puts a broker between checkout and its readers, which keeps the
message until a reader shows up — and pays for that with three separate bills: work can
vanish (ack too early), work can run twice (ack too late), work can get stuck for ever
(a message that will never process). Manual ack after the effect, an idempotent effect
and a DLQ are the three payments.

```
checkout()  ── COMMIT ──►  EventPublisher (confirm channel, mandatory)
                                │  order.placed
                                ▼
                    shop.events  (topic exchange)
                                │  binding: order.placed
                                ▼
            fulfilment.order-placed  (quorum, x-delivery-limit 5)
                │                                   │ nack(requeue=false) / delivery_limit
                ▼                                   ▼
   consumer: prefetch 32, noAck: false     shop.dlx (direct) ──► fulfilment.order-placed.dlq
   INSERT … ON CONFLICT DO NOTHING                              (no consumer; x-death says why)
   ack after the INSERT
```

| Piece | Where |
|---|---|
| event contract (`eventId`, `type`, `version`, `occurredAt`, `data`) | `src/messaging/events.ts` |
| topology: exchange, queue, binding, DLX, DLQ | `src/messaging/topology.ts` |
| publishing with confirms + `mandatory` | `src/messaging/publisher.ts` |
| the business operation that publishes | `checkout()` in `src/concurrency/checkout.ts` |
| consumer: manual ack, prefetch, idempotent effect | `src/messaging/order-placed.consumer.ts` |
| consumer as a process (`npm run consumer`) | `src/consumer.ts` |
| the effect table | `order_fulfilments`, migration `1790875996469-OrderFulfilments` |
| the three demos | `src/demo-publish.ts`, `src/demo-dlq.ts`, `src/demo-duplicate.ts` |

The broker is **RabbitMQ 4.2** (`rabbitmq:4.2-management-alpine`, 4.2.9 at the time of
these runs): the LTS series, supported until 30.06.2030, against 30.04.2028 for 4.3. The
`-management` image is what lets you open `http://127.0.0.1:15672` and look at `x-death`
with your own eyes. Compose's healthcheck is `rabbitmq-diagnostics -q check_running`, not
"the port is open": between the listener opening and the Erlang node accepting
`basic.publish` there is a window that answers with `ECONNRESET`, and `--wait` waits it out.

## Topology: declared by the consumer, not by the producer

`declareTopology()` is called by the consumer on start and by each demo as a bootstrap step
before it purges the queues. The producer imports only `EVENTS_EXCHANGE` — where to publish —
and never asserts a queue: if it did, it would have to know who listens to it.

The binding is what makes a routing key mean anything. Publish `order.placed` with no
binding and the broker confirms it, then drops it: its job was to route correctly, and
routing to nobody is correct. That is why the publisher also sets `mandatory: true` — see
below.

The work queue is a **quorum** queue with `x-dead-letter-exchange`, `x-dead-letter-routing-key`
and `x-delivery-limit: 5` set as queue arguments. Arguments are immutable: add or change one
on an existing queue and every `assertQueue` gets
`406 PRECONDITION_FAILED - inequivalent arg 'x-dead-letter-exchange'` until the queue is
deleted (`docker compose exec rabbitmq rabbitmqctl delete_queue fulfilment.order-placed`).
A policy (`rabbitmqctl set_policy … '{"dead-letter-exchange":"shop.dlx"}'`) can be
overwritten in place and is the better choice for a queue that already carries traffic;
here the queue is new and the arguments keep the whole topology in one file.

The DLX is `direct`, keyed by the work queue's name, so the same `shop.dlx` can later serve
other work queues without their dead letters mixing in one DLQ. Dead-lettering runs with the
default `dead-letter-strategy: at-most-once`. Switching to `at-least-once` silently does
nothing unless the queue also has `overflow: reject-publish`: the policy is accepted, shows up
in `effective_policy_definition`, and the broker falls back to at-most-once with a line in its
log as the only trace.

## Publishing: after COMMIT, with a confirm

`checkout()` commits the order, *then* publishes `order.placed` — never from inside the
transaction, where it could announce an order that a later statement rolls back. The body is
a contract built on purpose, not an entity spread; the `eventId` is derived from the order id
(`sha256('order.placed:' + orderId)`), so one fact has one identity no matter how many times
it is published — which is exactly what the consumer deduplicates on.

`EventPublisher` publishes on a **confirm channel** and resolves only on the broker's
`basic.ack`; a `basic.nack` rejects. "Published" therefore means "the broker took
responsibility", not "the bytes reached the socket". `mandatory: true` turns an unroutable
message into a `basic.return`, which RabbitMQ sends before the confirm for the same message, so
the confirm callback already knows it came back and rejects with `UnroutableEvent` instead of
reporting success.

What stays open: COMMIT done, process gone before the confirm, and the order exists with no
event. There is no shared COMMIT between Postgres and RabbitMQ; the transactional outbox closes
it — see [Transactional outbox and idempotency](#transactional-outbox-and-idempotency-outbox-та-ідемпотентність).

## Consumer: manual ack, after the effect

`channel.consume(…, { noAck: false })`, and every delivery ends in exactly one of three calls:

| Outcome | Call | What the broker does |
|---|---|---|
| effect applied, or already there | `ack` | forgets the message |
| cannot ever succeed (not parseable, unknown order — FK `23503`) | `nack(requeue = false)` | dead-letters it, reason `rejected` |
| anything else (database down, timeout) | `reject(requeue = true)` | redelivers it, until `x-delivery-limit` dead-letters it, reason `delivery_limit` |

The ack goes after the `INSERT`, never before: an ack is not "it arrived", it is "do not give
this to anyone again", and that is only true once the effect is in the database. Ack early and a
crash loses everything in the window; ack late and a crash redelivers it — there is no third
option, and the consumer is built for the second.

`reject` rather than `nack` for the retry path because on RabbitMQ 4.3 only `reject` counts
towards the delivery limit; with `nack` a failing message would loop for ever. On the 4.2.9 in
compose I measured both: a quorum queue with `x-delivery-limit: 2`, the same message requeued
by each call in turn — **both** dead-lettered it after 3 deliveries. The code uses the call that
is bounded on either version.

A `null` delivery is not "nothing to do": it is `basic.cancel` from the broker (the queue was
deleted, or `consumer_timeout` fired). The consumer process exits non-zero on it instead of
staying up, subscribed to nothing, acking into the void.

## prefetch = 32

The effect is one `INSERT`, 2–3 ms in every run below (`effect-ms-max`), and its worst case is a
pool that cannot hand out a connection, which fails after `DB_CONNECTION_TIMEOUT_MS = 5 s` — so
**32 × 5 s = 160 s < 1800 s** (the stock `consumer_timeout`), more than ten times under the limit,
while 32 deliveries in flight keep a 10-connection pool busy across the network round trip in a
way `prefetch = 1` cannot. The broker default of 0 means *unlimited*: the first consumer to
subscribe takes the whole queue and a second one idles. The value is set with `channel.prefetch(32)`
before `consume`, and `demo:publish` prints the number it actually passed.

## Idempotency: the effect is its own mark

Idempotency is a property of the operation; an idempotency key is a tool that makes a
non-idempotent operation safe to repeat. `UPDATE orders SET status = 'packed' WHERE id = 42` is
idempotent by itself; `qty = qty - 1` is not. The fulfilment effect is written so that it does
not need a separate key store:

```sql
INSERT INTO order_fulfilments (event_id, order_id, line_count, total_minor, handled_by)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT DO NOTHING
RETURNING event_id
```

`event_id` is the primary key and `order_id` is unique, so a second delivery of the same event
inserts nothing; one row back means "applied", zero means "duplicate", and there is no
`SELECT` first, so no window between the check and the write. The deduplication lives in
Postgres, next to the data: it survives a consumer restart and is shared by every replica —
unlike a `Set` in process memory, which lasts exactly as long as the process and does not
exist between two pods.

Here the row *is* both the effect and the "processed" mark, so they cannot drift apart. The
moment an effect grows beyond one statement (a second table, a call to a warehouse API), a
separate mark appears, and a crash between "marked" and "applied" leaves a key with no effect —
closing that takes the mark and the effect in one transaction, one COMMIT, which is
homework 22's `processed_messages`.

## The three runs

Each demo spawns the consumer as a **separate process** (`node dist/consumer.js`) and reads its
JSON-line stdout, runs pending migrations, re-declares the topology, purges both queues, and
resets its own buyer and product (`broker-demo@marketplace.test`) — so no seed is needed, and
they run in any order, any number of times. Each one checks its invariants and exits `1` if
one is broken.

```
$ npm run demo:publish
consumer pid 24533, prefetch 32

  order 21 placed → order.placed c7f973c810ddfa2d2a1cea6509e090da confirmed
  order 22 placed → order.placed bfe26f0ab36a20d3af2f7aad72f0f148 confirmed
  order 23 placed → order.placed e6190c0183c477804a865ea3ed763f0c confirmed
  order 24 placed → order.placed 9954f0e3ddb89258247ca812a915ffcb confirmed
  order 25 placed → order.placed 31b75726e9e46d78cbea6105ff2b3389 confirmed

published=5
delivered=5
effect=5
acked=5
work=0
dlq=0
prefetch=32
effect-ms-max=2.83
exit=0
```

```
$ npm run demo:dlq
published poison-1790876015067: an entity spread, not an order.placed event
consumer: dead-letter (eventId is missing)

x-death on poison-1790876015067:
  reason rejected, queue fulfilment.order-placed, count 1, exchange shop.events, routing-keys order.placed
x-first-death-reason: rejected
x-first-death-queue:  fulfilment.order-placed

rejected=1
work=0
dlq=1
dlq-reason=rejected
effect=0
exit=0
```

The poisoned message is what a producer sends when it spreads its ORM entity instead of
building the contract: no `eventId`, no `type`. No retry can make it parse, so the consumer
does not retry — `nack(requeue = false)`, and the work queue's DLX moves it to the DLQ. The
demo then reads it back with `basic.get`, prints `x-death` / `x-first-death-reason`, and puts
it back with `nack(requeue = true)` so it is still there (`dlq=1`) — the DLQ has no consumer,
it is where a person or a replay tool looks.

```
$ npm run demo:duplicate
consumer A pid 24617: applies the effect, then holds the ack
order 26 placed → order.placed cade871bcd7989db4477f9af3f4c486b confirmed
consumer A: effect in the database (1 row), ack not sent — killed with SIGKILL
consumer B pid 24618: normal consumer
consumer B: delivery #2, redelivered=true, effect skipped as a duplicate, acked

deliveries=2
effect=1
skipped=1
redelivered=1
work=0
dlq=0
exit=0
```

**How the duplicate is produced:** a real `kill -9`. Consumer A runs with
`--hold-ack-after-effect`: it commits the `INSERT`, reports it, and never acks. The demo sends
it `SIGKILL` — no handler runs, no `channel.close()`, the OS closes the socket, and the broker
sees a dead connection and returns the unacked delivery to the queue. A clean `channel.close()`
would also requeue, but that is a shutdown; a crash at 3 a.m. looks like this. Consumer B gets
the same message with `redelivered = true` (delivery #2 by the quorum queue's
`x-delivery-count`), the `INSERT` finds the row and returns nothing, B counts it as skipped and
acks. Two deliveries, one effect.

## At-least-once, not exactly-once

RabbitMQ does not deliver exactly once, and nothing does: the ack travels over the same network
that can fail, so a consumer that applied the effect can always die before the broker hears
about it, and the broker's only safe move then is to deliver again. What this setup gives is
**at-least-once delivery** — manual ack after the effect, confirms on publish, durable quorum
queues and persistent messages, so a message is either acknowledged or delivered again — plus an
**idempotent effect**: the `INSERT … ON CONFLICT DO NOTHING` keyed by a stable `eventId`, which
turns every repeat into a no-op. Together they give an **exactly-once result**, and
`demo:duplicate` is the place where that is visible: `deliveries=2`, `effect=1`. What I had to
build for the result to be one was the stable `eventId` derived from the order, the natural key
in the effect table, and the ack placed after the `INSERT` rather than before it.

# Transactional outbox and idempotency (Outbox та ідемпотентність)

Everything up to the broker homework rested on one assumption: the whole effect of checkout
lives in one database, so one COMMIT makes it atomic. Publishing `order.placed` breaks that.
Postgres and RabbitMQ are two resource managers with no shared COMMIT, and between "order
committed" and "event confirmed" there is a gap where a process can die. Publish after COMMIT
and a crash loses the event. Publish before COMMIT and a rollback announces an order that never
existed.

The outbox closes that gap by not writing to the broker from the business operation at all.
The event becomes a row, committed together with the order, and a separate relay moves rows to
the broker. That gives **at-least-once** delivery and nothing better, so the consumer has to make
the effect idempotent. That's what pays for the outbox.

```
POST /checkout  Idempotency-Key: k
  │
  ▼  BEGIN
  │  INSERT idempotency_keys (buyer, k) ON CONFLICT DO NOTHING     ← level 3: API edge
  │  UPDATE products / users, INSERT orders, order_items, jobs
  │  INSERT outbox (id = eventId, aggregate_type, aggregate_id, type, payload)
  │  COMMIT                                ← order and event: one COMMIT, or neither
  │
relay (separate process, polls every 100 ms)
  │  BEGIN
  │  SELECT … WHERE published_at IS NULL ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 50
  │  publish → shop.events / order.placed, wait for the broker's confirm
  │  UPDATE outbox SET published_at = now(), attempts = attempts + 1
  │  COMMIT
  ▼
fulfilment.order-placed ──► consumer (separate process)
                              BEGIN
                              INSERT processed_messages (message_id, consumer) ON CONFLICT DO NOTHING   ← level 2: inbox
                              INSERT order_fulfilments … ON CONFLICT DO NOTHING                         ← level 1: natural key
                              COMMIT, then ack
```

| Piece | Where |
|---|---|
| migration: `outbox`, `processed_messages`, `idempotency_keys`, partial index | `src/migrations/1792664108077-OutboxInboxIdempotencyKeys.ts` |
| entities | `src/entities/outbox-message.entity.ts`, `processed-message.entity.ts`, `idempotency-key.entity.ts` |
| event contract, `toOrderPlacedEvent()` | `src/messaging/events.ts` |
| order + outbox row in one transaction | `placeOrder()` in `src/concurrency/checkout.ts`, `appendToOutbox()` in `src/outbox/outbox.ts` |
| Idempotency-Key at the API edge | `src/orders/place-order-once.ts`, `POST /checkout` in `src/orders/checkout.http.ts` |
| relay: one pass | `relayBatch()` in `src/outbox/relay.ts` |
| relay as a process (`npm run relay`) | `src/relay.ts` |
| idempotent consumer, two levels | `applyFulfilment()` in `src/messaging/order-placed.consumer.ts` |
| the three demos | `src/demo-outbox.ts`, `src/demo-crash-write.ts`, `src/demo-crash-relay.ts` |

The broker is the RabbitMQ from the broker homework: a separate process, so there really are two
resource managers. Secrets come from the same store. Every new npm script that touches the
database starts with `bash scripts/with-secrets.sh dev …`, and `BROKER_URL` already lives
there next to `DB_URL`. No new env file was added.

## The outbox table

```sql
CREATE TABLE outbox (
  id             uuid PRIMARY KEY,          -- = the event's eventId
  aggregate_type text NOT NULL,             -- 'order'
  aggregate_id   text NOT NULL,             -- the order id
  type           text NOT NULL,             -- 'order.placed', also the routing key
  payload        jsonb NOT NULL,            -- the event contract, not the entity
  created_at     timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,               -- NULL = not relayed yet
  attempts       integer NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);
CREATE INDEX idx_outbox_unpublished ON outbox (created_at, id) WHERE published_at IS NULL;
```

Created by a migration, not by `synchronize`. As in the earlier homeworks, it was generated from
the entities and trimmed of the generator's two known false diffs. `up` → `down` → `up` was run
before committing.

The partial index holds the backlog, not the history. The relay's query matches it exactly
(`WHERE published_at IS NULL ORDER BY created_at, id`), and a row drops out of it the moment it
is marked. `outbox` has **no foreign key** to `orders`. It is a log of what was said, read by
something that knows nothing about the domain (the relay today, Debezium later), and an event
must be able to outlive the row it was about.

The column roles are the ones the **Debezium Outbox Event Router** reads, so moving from polling
to CDC changes connector config, not consumers. Debezium's canonical names have no underscore
(`aggregatetype`, `aggregateid`), and `route.by.field` defaults to `aggregatetype`. Here the
snake_case names are kept and mapped explicitly:

```properties
transforms=outbox
transforms.outbox.type=io.debezium.transforms.outbox.EventRouter
transforms.outbox.table.field.event.id=id
transforms.outbox.table.field.event.key=aggregate_id
transforms.outbox.table.field.event.payload=payload
transforms.outbox.route.by.field=aggregate_type
transforms.outbox.table.fields.additional.placement=type:header:type
```

`published_at` and `attempts` belong to the polling relay; a CDC pipeline ignores them.

**Cleanup.** The table only grows, and published rows still cost space and vacuum work even though
the partial index skips them. A nightly job deletes what has been out for a week, in batches so
it never holds a long lock:
`DELETE FROM outbox WHERE id IN (SELECT id FROM outbox WHERE published_at < now() - interval '7 days' LIMIT 10000)`,
repeated until it deletes nothing. Unpublished rows are never deleted. A row with a growing
`attempts` and no `published_at` is a stuck event, and that's what to alert on.

## The business operation: one COMMIT

`placeOrder()` is the transactional checkout from the concurrency homework, with one extra
statement at the end: `appendToOutbox(manager, { type: 'order', id: order.id }, event)`. Same
`EntityManager`, so same connection, same transaction, same COMMIT. That matters: the
transaction lives on one client (`dataSource.transaction(...)`), not on `pool.query('BEGIN')`,
where BEGIN and COMMIT could go to two different connections. Nothing inside the transaction
talks to the broker, because a broker cannot roll back.

The payload is built by `toOrderPlacedEvent()`, an explicit contract (`eventId`, `type`,
`version`, `occurredAt`, `data: { orderId, buyerId, totalMinor, currency, lines }`), never an
entity spread. A column rename stays a migration, not a breaking change for every consumer. The
`eventId` is derived from the order (`sha256('order.placed:' + orderId)`, shaped as a UUID because
it is also `outbox.id`), so the same fact has the same identity on every publish. That identity is
what the consumer deduplicates on.

`checkout()` keeps the broker homework's optional publish after COMMIT, and only
`demo:publish` and `demo:duplicate` use it. The outbox row is written either way, so
when the relay later sends such an event again, the inbox absorbs it as one more duplicate.

## The relay

```sql
SELECT id, type, payload, created_at FROM outbox
 WHERE published_at IS NULL
 ORDER BY created_at, id
 FOR UPDATE SKIP LOCKED
 LIMIT 50
```

then every row is published on the confirm channel with `messageId = outbox.id`, and only
after all confirms come back
`UPDATE outbox SET published_at = now(), attempts = attempts + 1 WHERE id = ANY(…)`, then COMMIT.
All of it is one transaction on one connection (`createQueryRunner()`), so the row lock covers
the whole publish.

- **SKIP LOCKED, not a bare `FOR UPDATE`.** With `FOR UPDATE` a second relay waits on the first
  one's locks: no duplicates, and no parallelism either. With `SKIP LOCKED` it takes the next rows
  instead. Two relays never hold the same row, and they work in parallel.
- **`published_at IS NULL`, not a cursor on `id`.** An id is handed out when the row is inserted
  and becomes visible at COMMIT, and those two orders differ. A transaction that drew id 41 and
  committed after 42 is invisible at the moment the cursor moves past 41, and "everything above
  the last id" skips it for good. The `NULL` predicate finds a row whenever it commits.
- **Ordering.** `ORDER BY created_at, id` is the order of *selection*, not of delivery. Two relays
  with `SKIP LOCKED` interleave batches, and a failed publish is retried after newer rows went
  out. This consumer doesn't need ordering: every `order.placed` is a different order and the
  effect is per order. If it ever does, the order exists only within a partitioning key
  (`aggregate_id`), by routing one aggregate to one queue and one relay, not by sorting.
- **A failed publish** (nack, unroutable with `mandatory`, broker gone) leaves the row unpublished
  with `attempts + 1`, and the next pass tries again. A failure is *not* proof that the message
  isn't in the queue, because the confirm itself can be what got lost. So "caught the error, rolled
  back, all clean" doesn't hold, and the consumer deduplicates regardless of how careful the relay is.
- **`attempts` survives only a failed publish, not a crash.** A crash rolls back the whole pass,
  including the increment. That's acceptable: the crash is the case `demo:crash-relay` covers,
  and a crashed relay is visible in its own logs.

### Why publish and `UPDATE published_at` cannot swap places

The order is publish → UPDATE, and the swap looks like it would fix the duplicate:
mark first, then publish, and a crash can't make the relay publish twice. That's true, and it
breaks the other way. Mark first, then die (or have the publish fail, or have the broker drop the
message) before the publish, and the row says "published" about an event that was never sent.
No later pass looks at it again, because it no longer matches `published_at IS NULL`, and no
consumer can tell that an event it never received is missing. The choice isn't between good and
bad. It's between a **duplicate** and a **loss**. A duplicate is cured downstream by
deduplication, the two levels below. Nothing cures a loss. Doing the UPDATE in a *separate*
transaction after the publish doesn't change this: there is still a moment where one of the two
has happened and the other hasn't. So the order stays publish, then mark, and the consumer
treats every message as possibly the second copy.

## The consumer: two levels, one transaction

```sql
BEGIN;
INSERT INTO processed_messages (message_id, consumer) VALUES ($eventId, 'fulfilment')
ON CONFLICT DO NOTHING RETURNING message_id;      -- no row → already handled: skip, COMMIT, ack
INSERT INTO order_fulfilments (event_id, order_id, …) VALUES (…)
ON CONFLICT DO NOTHING RETURNING event_id;        -- no row → the effect is already there
COMMIT;                                           -- then ack
```

**Level 1, the natural key.** The effect is phrased so that applying it twice changes nothing:
one fulfilment per order (`order_id` unique, `event_id` the primary key), inserted with
`ON CONFLICT DO NOTHING`. Not `UPDATE … SET qty = qty - 1`, which on a second delivery takes
twice.

**Level 2, the inbox.** `processed_messages (message_id, consumer)` with the pair as primary key.
The `consumer` is the logical name `fulfilment`, not the process, so every replica shares one inbox
and two different consumers of the same event each handle it once. The mark and the effect go in
the **same transaction**. A mark in Redis next to an effect in Postgres, or the two in two
transactions, is a dual write again, just moved from the producer to the consumer: crash between
them and there's a mark with no effect, an event that is silently skipped forever.

Both are `INSERT … ON CONFLICT DO NOTHING`, never `SELECT` then `INSERT`. A check followed by a
write has a window in which two deliveries both see "new".

## The API edge: Idempotency-Key (level 3)

`POST /checkout` (`src/orders/checkout.http.ts`, an express app that needs only a `DataSource`;
the Nest `/orders` resource is still the in-memory one from the contract homework) takes the same
`Idempotency-Key` header as the contract homework, now with server state in Postgres:

```sql
BEGIN;
INSERT INTO idempotency_keys (buyer_id, key, request_hash) VALUES (…)
ON CONFLICT DO NOTHING RETURNING key;
-- one row → this request owns the key: placeOrder() (+ outbox), store order_id, COMMIT → 201
-- no row  → SELECT request_hash, order_id → 200 + Idempotency-Replay: true
--           (or 422 if the same key came with a different body)
```

The claim, the order and its outbox row commit together. A declined or crashed checkout takes
the claim with it (`demo:crash-write` prints `keys=0`), so the client can retry with the same key.
Two requests with one key **at the same time** don't race either. The second `INSERT` hits the
first one's uncommitted row in the unique index, so Postgres makes it wait for that transaction.
Then `DO NOTHING` applies, and under READ COMMITTED the `SELECT` that follows sees the committed
`order_id`.

The key is per buyer (`PRIMARY KEY (buyer_id, key)`) and it identifies the **intent**, not the
body. A hash of the body as the key would merge two legitimate identical orders (two of the same
item, bought on purpose a minute apart) into one. `request_hash` is stored only to refuse the
same key reused for a *different* body.

## The three runs

All three spawn the consumer and the relay as **separate processes** (`node dist/consumer.js`,
`node dist/relay.js`) and read their JSON-line stdout. Each demo uses its own buyer
(`outbox-demo@`, `crash-write-demo@`, `crash-relay-demo@marketplace.test`). On start each one
deletes that buyer's orders, their outbox rows and inbox marks, purges the queues and resets stock
and balance. Every count is scoped to that buyer or to the demo's own `eventId`, because the dev
database can hold other pending outbox rows (`demo:race` leaves ten), which the relay legitimately
publishes alongside. Each demo checks its own invariants and exits `1` if one is broken.

```
$ npm run demo:outbox
consumer pid 87360, relay pid 87363, api http://127.0.0.1:56934

  POST /checkout  Idempotency-Key: 18c94cbf…  → 201 order 76
  POST /checkout  Idempotency-Key: 18c94cbf…  → 200 order 76  (Idempotency-Replay: true)
  outbox row e8fe8c3d-9d4a-d434-765e-34966b98f044 committed with order 76
  relay: published + marked; consumer: effect applied, inbox marked, acked

requests=2
created=1
replayed=1
orders=1
outbox=1
published=1
relayed=1
deliveries=1
applied=1
effect=1
processed=1
exit=0
```

Two requests sent concurrently with one key produce one order, one outbox row, one publish, one
delivery, one effect and one inbox mark.

```
$ npm run demo:crash-write
consumer pid 87376, relay pid 87377

  inside the transaction: order 77 (1 row), outbox 55b95ced-b216-2f01-1294-f50a497e06dd (1 row) — now failing before COMMIT
  simulated crash after the outbox insert, before COMMIT → ROLLBACK
  relay: 5 passes since, nothing of ours picked up

write-failed=1
outbox-inside-tx=1
orders=0
outbox=0
published=0
relayed=0
deliveries=0
effect=0
keys=0
exit=0
```

**The business write fails.** `placeOrderOnce()` runs in full (key claimed, stock and balance
taken, order inserted, outbox row inserted), and a hook placed after the outbox insert throws
before COMMIT. Inside the transaction the demo counts the outbox row (`outbox-inside-tx=1`), so
the row really was written. After the rollback the order, the row, the key and the stock
decrement are all gone, and the relay and consumer, running the whole time, never see the event.
They are one COMMIT, so one ROLLBACK takes both. With two COMMITs, the outbox row would be here.

```
$ npm run demo:crash-relay
order 78 + outbox ed21fbec-a795-2406-c198-893859179947 committed
relay A pid 87385: publishes, then holds before UPDATE published_at
relay A: confirmed by the broker, consumer applied it (1 row), published_at still NULL — killed with SIGKILL
relay B pid 87389: normal relay
relay B: published it again and marked it; consumer: duplicate, skipped, acked

published=2
deliveries=2
applied=1
skipped=1
acked=2
effect=1
processed=1
marked=1
exit=0
```

**The service write fails. How the relay is killed:** a real `kill -9` of a child process, not a
simulated exception. Relay A runs with `--hold-after-publish=<eventId>`. It locks the row,
publishes, gets the broker's confirm, and then stops inside `beforeMark`, which is the exact spot
between publish and `UPDATE published_at`. While it is held, the consumer receives the event and
commits the effect plus the inbox mark, and the demo checks that `published_at` is still `NULL`.
Then `SIGKILL`: no handler runs, the OS closes the socket, and Postgres rolls back the relay's
transaction (through PgBouncer) and releases the row lock. Relay B finds the row still
unpublished, publishes it again and marks it. The consumer gets the same `eventId` a second time,
the inbox `INSERT` returns nothing, and it skips the effect and acks.

## At-least-once + idempotent effect = exactly-once result

There is no exactly-once delivery. That's the two generals problem: the last acknowledgement
always travels over a network that can lose it, so somebody always has to choose between maybe
sending twice and maybe not sending at all. The outbox picks "maybe twice" on every hop. The
relay republishes anything it didn't mark, and the consumer acks only after its COMMIT. Kafka's
exactly-once semantics hold inside Kafka (read-process-write between its own topics). Once the
other end is a Postgres table, the guarantee comes down to the deduplication key again. What
turns at-least-once delivery into an exactly-once **result** is the idempotent effect: a stable
`eventId` derived from the order, the inbox mark in the same transaction as the effect, and an
effect keyed by the business fact. `demo:crash-relay` is where you can see it: `deliveries=2`,
`effect=1`.

# Redis: cache, sessions, limits, queue (Redis: кеш, сесії, ліміти, черга)

The outbox homework made the system correct: the order and its event commit together, and the
effect is idempotent. Nothing here makes it more correct. Redis makes it faster and keeps it
standing under load. Four jobs, one rule for all of them: before you trust a Redis structure,
ask what happens when it fails. For the cache and its lock the answer is "one more trip to
Postgres". That is why a lock is acceptable there, and why no business invariant in this
repository is protected by one.

| Piece | Where |
|---|---|
| the two instances, policies set explicitly | `docker-compose.yml` (`redis-cache`, `redis-queue`) |
| connections, `CONFIG GET` at runtime | `src/redis/connection.ts` |
| cache-aside, jittered TTL, single-flight lock, compare-and-delete | `src/cache/cache-aside.ts` |
| the cached read: the product card | `src/repositories/product-cards.repository.ts`, `src/cache/product-cards.ts` |
| the database call counter | `CountingQueryable` in `src/repositories/counting.ts` |
| session store with a rolling TTL, cookie middleware | `src/sessions/session-store.ts`, `src/sessions/session.middleware.ts` |
| sliding-window limiter, 429 + `Retry-After` | `src/ratelimit/sliding-window.ts` |
| a stateless pod (sessions + limit) as a process | `src/pod.ts`, started by `src/redis/pod-process.ts` |
| BullMQ queue, retries, `jobId`, job scheduler | `src/queue/notifications.ts` |
| the four demos | `src/demo-cache.ts`, `src/demo-session.ts`, `src/demo-ratelimit.ts`, `src/demo-queue.ts` |

Secrets come from the same store as the database and the broker. `REDIS_URL` and
`REDIS_QUEUE_URL` live in `.env` next to `DB_URL` and `BROKER_URL`, without a password; the
password is in `secrets/redis_password`, read through `REDIS_PASSWORD_FILE` the same way
`db_password` is. No new env file was added. All four demo scripts start with
`bash scripts/with-secrets.sh dev …`, and `SKIP_VAULT=1` works for them unchanged.

## Two instances, and why

| | `redis-cache` (56379) | `redis-queue` (56380) |
|---|---|---|
| holds | product cards, stampede locks | BullMQ jobs, sessions, rate-limit windows |
| `maxmemory` | 64 MB | 256 MB |
| `maxmemory-policy` | `allkeys-lru` | `noeviction` |
| persistence | none | AOF, `appendfsync everysec` |
| losing a key costs | one query to Postgres | a lost job, a logged-out user, a leaked limit |

**There are two instances because a cache needs `maxmemory` + `allkeys-lru` and BullMQ needs
`noeviction`, and both settings apply to the whole Redis process.** `SELECT 1` gives you a
second keyspace with the same memory limit and the same policy, so it does not solve this.
The demos read both values back over their own connection (`CONFIG GET`), so `cache-lru=1` and
`queue-noeviction=1` describe the instances they actually talked to. Point the queue at the
cache and the difference shows up immediately:

```
$ REDIS_QUEUE_URL=redis://:redis_dev_password@127.0.0.1:56379 node dist/demo-queue.js
IMPORTANT! Eviction policy is allkeys-lru. It should be "noeviction"
  FAIL  queue instance never evicts: allkeys-lru
queue-noeviction=0
```

**Sessions go into the queue instance, not a third one.** Their requirements match the queue's:
a session must never be evicted, because LRU would log out whoever was idle longest, and a
restart should not log everybody out, which AOF covers. A third container would be one more
thing to run with the same settings. Rate-limit windows are there for the same reason. If they
lived under LRU, an evicted window would quietly reset a client's count.

## Cache-aside on the product card

The cached read is the product card: the product, its seller's name, the stock, and units and
orders sold, which is a `LEFT JOIN LATERAL` aggregate over `order_items` joined with `orders`.
That aggregate gets slower with every checkout, and it is the read a catalogue page repeats
for every product.

```
GET card:product:<id>
  hit   → JSON from Redis, Postgres not touched
  miss  → SET lock:card:product:<id> <uuid> NX PX 3000
            won  → GET again (the previous holder may just have filled it)
                   → SELECT … → SET card:product:<id> <json> EX 300 + random(0..60)
                   → release: compare-and-delete with our <uuid>
            lost → poll the key every 20 ms; past the lock's 3 s, read Postgres directly
```

- **TTL is always set, and it is jittered:** 300 s + `randomInt(0, 61)`. A pass that warms 60
  keys in one go would otherwise schedule 60 expiries in the same second, and the stampede
  would come back every five minutes. `ProductCards.invalidate()` exists for a write to call,
  but it is an extra on top of the TTL and does not replace it. A product that does not exist
  is cached too, as an absence marker with a 30 s TTL, so a crawler asking for missing ids
  does not reach Postgres on every request.
- **The lock is released by its own token only.** The release is a Lua compare-and-delete
  (`if get == token then del`), which works on any Redis version. `DELEX … IFEQ` does the same
  natively from 8.4, which the compose image is, but the script does not depend on that. A bare
  `DEL` from a holder whose lock has already lapsed would delete the lock someone else took
  in the meantime. Step 5 of the demo shows the case: A's lock lapses, B takes it, A's release
  removes 0 keys, and B still holds it.
- **A cache failure is never the user's failure.** Every Redis call in `CacheAside` is wrapped:
  a failed `GET` is a miss, and a failed `SET` (an `OOM command not allowed` from an instance
  without eviction, a timeout, a dropped socket) is logged and the value is still returned. If
  the lock command itself fails, the read goes to Postgres. The cache connection has
  `maxRetriesPerRequest: 1` and a 500 ms `commandTimeout`, so a Redis that hangs counts as a
  miss and the request does not wait on it.

`db-calls` is counted by `CountingQueryable`, which sits **under** the repository. Every SQL
statement the repository sends passes through it, so the number is round trips to Postgres,
not calls to a function that might or might not reach the database. The loader adds 150 ms
to the query (`LOAD_DELAY_MS`), standing in for the aggregate on a production-sized
`order_items`. That makes the stampede window wide enough to see. The lock does not depend on
it: the double-check under the lock makes `db-calls=1` hold even with no delay.

```
$ npm run demo:cache
cache instance: maxmemory-policy allkeys-lru, maxmemory 67108864 bytes

1. warmed 60 cards with 60 queries; TTLs 300..360 s, 40 distinct values
2. key expired (gone); 50 concurrent reads → 1 query (loaded 1, waited 49)
3. 100 reads of warm cards → 0 queries (hit 100)
4. control, lock off: 50 concurrent reads → 50 queries
5. A's lock lapsed, B took it (true); A's compare-and-delete removed 0 key; B still holds it: true

cache-lru=1
cache-maxmemory=1
warmed=60
ttl-distinct=40
db-calls-cold=60
concurrent=50
db-calls=1
db-calls-warm=0
db-calls-without-lock=50
foreign-lock-kept=1
```

The key in step 2 really expires (`PEXPIRE 1`, then a check that it is gone) before 50 HTTP
requests arrive at once. One wins `SET NX` and runs one query; the other 49 wait and get the
value from the cache. Step 4 is the same burst with `singleFlight: false`, and it costs 50
queries. `ttl-distinct` changes from run to run (36 and 40 in two runs here, out of 61
possible values). Without jitter it would be 1.

### If the stampede lock breaks

It can break in two ways. The holder can pause (GC, a page fault, a container being moved)
for longer than its 3 s lock, so the lock lapses and a second request takes it. Or Redis can
lose the lock key: a failover to a replica that never saw the write, or a restart of an
instance that persists nothing. Either way **two requests read the same card from Postgres
and both write it to the cache.** Both write the same data, the last `SET` wins, and the next
TTL fixes anything stale. The cost is one extra query, perhaps a few, at the moment the key
expired. Nothing is corrupted, because the lock never guarded the data. It only guarded how
many times the database is read. Checking "is the lock still mine?" before the write would not
make it safe either, because the pause can fall between the check and the write. Only a
fencing token checked by the store itself closes that gap, and paying for one to save a single
`SELECT` makes no sense. That is why a plain `SET NX PX` on one Redis is enough here, and why
it would not be enough for anything whose failure means corrupted state. Stock and balance in
checkout are protected by an atomic conditional `UPDATE` in Postgres, and the order event by a
unique key and the inbox. None of them relies on a lock.

## Sessions with a rolling TTL

A session is a hash `sess:<id>` on the queue instance. The id is 256 bits from the CSPRNG
(`randomBytes(32)`), carried in an `HttpOnly; SameSite=Lax` cookie. Every request through
`sessionMiddleware` runs one Lua script: if the key exists, increment `hits`, set
`lastSeenAt`, `EXPIRE` it to the full TTL again, and return the hash. It is one script rather
than `HGETALL` + `EXPIRE`, because a session that expired between those two commands would
come back as a hash recreated by `HINCRBY` with no TTL at all, and it would never expire.
The cookie is re-issued with the same id and a fresh `Max-Age`, so both ends roll together.
The process keeps nothing in memory.

```
$ npm run demo:session
1. pod A (pid 43119): new session VAG5vDV2…, hits 1
2. after 2 s idle: TTL 57991 ms → request → 59996 ms, hits 2
   pod A killed with SIGKILL, pod B started (pid 43123)
3. pod B (pid 43123): same cookie → hits 3, then 4
   sess:VAG5vDV2… in Redis: true, TTL 60 s of 60

requests=4
sessions=1
in-redis=1
ttl-before-ms=57991
ttl-after-ms=59996
ttl-renewed=1
survived-restart=1
hits=4
```

The server runs as a real child process (`dist/pod.js`) and is killed with `SIGKILL`, so nothing
it held in memory could have been saved. The new process on a new pid finds the same session
with its counter intact: `hits` goes 1, 2, 3, 4 across the kill. The demo TTL is 60 s
(`--session-ttl`); the default for a pod is 30 min. The 2 s pause before request 2 is what
makes `ttl-renewed` mean anything, because without it the TTL would not have had time to drop.

## Rate limit on the shared store

**Model: a sliding-window log, because the point of this limit is to allow no burst.** A fixed
window lets `2 × limit` through around every reset (5 at 12:00:59 and 5 more at 12:01:00), and
a token bucket lets a full bucket go at once by design. Here the limit is meant to be a
hard ceiling over any 10 s span.

The window is a sorted set `rl:<client>`, one member per admitted request, scored by when it
was admitted. All of it is one Lua script: drop the members older than the window, `ZCARD`,
and either `ZADD` + `PEXPIRE` or compute `Retry-After` from the oldest member. Unlike the cache
lock, atomicity here is about correctness. With `ZCARD` and `ZADD` as separate commands,
another pod gets in between, both see `limit - 1`, both are admitted, and the limit leaks
exactly when load is high. The script reads the clock with Redis `TIME`, so pods whose clocks
disagree still share one window. The client is `X-Client-Id` (an API key in practice), falling
back to the socket address. A rejection is `429` with `Retry-After` in whole seconds, rounded
up. If Redis is unreachable, the limiter fails open and logs it, so a Redis outage does not
become an API outage.

```
$ npm run demo:ratelimit
pods: pid 43190, pid 43191; limit 5 per 10 s per client

  pod 0 (pid 43190): 3 allowed, 7 blocked
  pod 1 (pid 43191): 2 allowed, 8 blocked
  last rejection: 429 Retry-After: 10 s

instances=2
limit=5
requests=20
allowed=5
blocked=15
status=429
retry-after=1
pods-that-admitted=2
```

The two pods are separate processes with separate limiter objects; the only thing they share
is Redis. The 20 requests are sent **concurrently**, alternating between the pods, so the
atomicity is tested by real interleaving and not by requests taking turns. Exactly 5 get
through, split between both pods. With the counter in process memory (which is what
`@nestjs/throttler` does by default), each pod would admit 5, giving `allowed=10` and no 429.

## The queue: BullMQ

One queue, `order-notifications`, on the queue instance, with two kinds of job:

- **`order-placed`**: the confirmation to the buyer for an `order.placed` event, which is the
  event the outbox relay publishes. Its `jobId` is `order-placed-<eventId>`. The relay delivers
  at least once, so the same event can be enqueued twice, and the second `add` with the same
  id does nothing. `attempts: 4`, `backoff: { type: 'exponential', delay: 200, jitter: 0.5 }`.
  `removeOnComplete: { age: 86400 }` and not `true`: a removed job no longer counts as a
  duplicate, so `true` would turn deduplication off as soon as the first copy completed.
- **`recompute-ratings`**: periodic, created by `upsertJobScheduler('recompute-ratings',
  { every })`. It is an upsert keyed by the scheduler id, so every restart that calls it leaves
  one scheduler with the latest settings instead of adding another. The repeatable-job API
  (`repeat`, `getRepeatableJobs`) no longer exists in BullMQ 6.

The worker's connection is opened with `maxRetriesPerRequest: null`, so it waits through a
Redis outage instead of throwing out of its blocking command. The queue's connection is not:
on the request path, an `add` should fail fast.

```
$ npm run demo:queue
queue instance: maxmemory-policy noeviction

1. add × 2 with jobId order-placed-95d1743a-… → 1 job in the queue (second add returned order-placed-95d1743a-…)
2. upsertJobScheduler × 2 → 1 scheduler (every 400 ms)
3. worker started
   attempt 1: mail provider answered 503
   attempt 2: mail provider answered 503, 232 ms after the previous one
   attempt 3: confirmation for order demo sent, 313 ms after the previous one
   scheduler: 7 runs in 2.5 s
4. add after completion → job order-placed-95d1743a-… is completed; 1 confirmation job in total

queue-noeviction=1
attempts=3
completed=1
added=2
queued=1
schedulers=1
scheduled-runs=7
deduped-after-complete=1
```

The job fails through its data (`failTimes: 2`): the handler throws while `attemptsMade` is
below it, which stands in for a mail provider answering 503 twice. `attempts` counts how many
times the handler actually ran. The gaps between attempts grow (≈200 ms, then ≈300–400 ms,
with jitter and the worker's own polling on top). `queued` is the total across every job state
after the two adds, before the worker starts. Step 4 is why `removeOnComplete` is an age: the
same event arriving after the job finished still finds it and is still a duplicate.
`scheduled-runs` depends on load, because BullMQ creates the next scheduled job only once the
previous one has been picked up. It was 7 in 2.5 s at 400 ms in both runs here.

## A lock is not idempotency

A lock holds only while it is valid and only while its holder keeps running. The
idempotent consumer from the outbox homework survives a worker restart and a redelivery,
because its guarantee is a unique key that Postgres checks on every write. The queue adds a
second dedup layer (`jobId`) in front of that, not instead of it: a job that sends an email
and crashes before it is marked complete will run again, so the mail provider call should
carry the `eventId` as its own idempotency key too.

# Auth (Автентифікація та авторизація)

Until this homework `POST /orders` took the buyer from an `X-User-Id` header: anybody could
order anything in anybody's name. Now the API keeps two questions apart, because they are
answered by different things:

- **Authentication — "who is this?"** A fact checked by cryptography: an ES256 signature over
  the access token. No token, a malformed one, a forged one, an expired one, a revoked one: **401**.
- **Authorization — "may they do this?"** A decision that cryptography cannot make, because it
  depends on data the token does not carry (who owns order `o_7`). A valid token without the
  right: **403**.

The difference is not cosmetic. A client SDK answers 401 by refreshing the token and 403 by
showing an error. Swap them and the app either loops on refresh or logs the user out every time
they open a page that is not theirs.

| Piece | Where |
|---|---|
| login, rotation with reuse detection, logout, access-token verification | `src/auth/auth.service.ts` |
| ES256, the key ring (`kid` → key), fingerprints | `src/auth/keys.ts` |
| `AccessTokenGuard` (401), `RolesGuard` + `@Roles()` (403), `@CurrentPrincipal()` | `src/auth/guards.ts` |
| `POST /auth/login`, `/auth/refresh`, `/auth/logout`, `GET /auth/me` | `src/auth/auth.controller.ts` |
| scrypt password hashes (node:crypto, no new dependency) | `src/auth/password.ts` |
| ownership — one rule for HTTP, SSE and the WebSocket room | `src/realtime/order-access.ts` |
| `users.role` / `users.password_hash`, `refresh_tokens`, `revoked_access_tokens` | `src/migrations/1793349700000-AuthRolesRefreshTokens.ts` |
| the store: keys and pepper per environment | `secrets/jwt/<env>/` (git-ignored), `scripts/jwt-keys.mjs`, `scripts/with-secrets.sh` |
| fail-fast on a missing key, before anything else is imported | `src/main.ts`, `src/config/env.schema.ts` |
| the three demos and their kit | `src/demo-auth.ts`, `src/demo-reuse.ts`, `src/demo-rbac.ts`, `src/auth/demo-kit.ts` |
| the same sequences as tests | `test/e2e/auth.e2e.test.ts` |

**The domain.** `orders` is the resource with an owner (`buyer_id` = the `sub` of the token that
created it); `products` is the resource only a privileged role writes to (`seller` or `admin`;
reading the catalogue stays public). Three roles live in `users.role`: `buyer` (the default),
`seller` (the migration makes everybody who already sells something a seller) and `admin`.

## Variables

| Variable | Джерело | Format | Purpose |
|---|---|---|---|
| `JWT_PRIVATE_KEY` | **secrets store** (#11): `secrets/jwt/<env>/private.pem` via `with-secrets.sh` | base64 of a PKCS#8 PEM, EC P-256 | signs access tokens |
| `JWT_PUBLIC_KEY` | **secrets store** (#11): `secrets/jwt/<env>/public.pem` | base64 of an SPKI PEM | verifies them; must be the public half of the private key |
| `JWT_KID` | **secrets store** (#11): `secrets/jwt/<env>/kid` | `[A-Za-z0-9._-]{1,64}` | written into every token header; picks the verifying key |
| `REFRESH_TOKEN_PEPPER` | **secrets store** (#11): `secrets/jwt/<env>/pepper` | ≥ 12 characters | HMAC key for `refresh_tokens.token_hash` |
| `JWT_PREVIOUS_PUBLIC_KEY` | **secrets store** (#11): `secrets/jwt/<env>/previous/public.pem`, only during a rotation | base64 SPKI PEM | still verifies tokens of the outgoing key |
| `JWT_PREVIOUS_KID` | **secrets store** (#11): `secrets/jwt/<env>/previous/kid` | as `JWT_KID` | the outgoing key's id |
| `DATABASE_URL` / `DB_URL` | compose / оточення | `postgres://…` | dev credentials of the compose stack, not a secret |
| `JWT_ISSUER`, `JWT_AUDIENCE` | оточення (default `marketplace-api`) | string | `iss` / `aud`, written and required |
| `JWT_ACCESS_TTL_SECONDS` | оточення (default `600`) | 30–3600 | access-token lifetime |
| `REFRESH_TTL_SECONDS` | оточення (default 30 days) | ≥ 60 | refresh-token lifetime |

The six store variables have **no default** in `src/config/env.schema.ts`. A default for a signing
key is a signing key committed to git. The price of a leak is also different in kind:
`DATABASE_URL` gives access to the database from the network, while the signing key lets anyone
mint a token for any user without access to anything. So `npm run start` stays a bare start and
dies naming the missing variables. `npm run start:vault` (`bash scripts/with-secrets.sh dev npm
run start`) and the three demos go through the store. `.env.example` lists the store variables with
an empty value, and `npm run check:env` refuses any other value for them.

The schema also checks that the private key is EC P-256, that the public key is its pair, and that
a previous `kid` differs from the current one. The validator never echoes a store variable's value
back. `main.ts` runs `validate(process.env)` as the process's first action, before Nest, the
`pg` pool or the spec validator is imported. A bare start without keys therefore reports
`JWT_PRIVATE_KEY`, not `ECONNREFUSED`.

The store for an environment is the existing one: the git-ignored `.env` (or `.env.<env>`) plus
files under `secrets/`. No new env file was added. The keys live in `secrets/jwt/<env>/`:

```bash
node scripts/jwt-keys.mjs generate dev     # first key of an environment; refuses to overwrite
node scripts/jwt-keys.mjs fingerprint dev  # kid + fingerprint, never the key
```

`scripts/with-secrets.sh <env>` exports them base64-encoded next to `DB_PASSWORD`. A store that has
no keys yet is not an error for `migrate` or `seed`; only the API refuses to start.

**Fingerprints — two environments, two keys** (SHA-256 over the DER of the public key, the first
16 bytes; safe to print, and what the API logs at startup instead of anything secret):

| Environment | `kid` | Fingerprint |
|---|---|---|
| dev | `dev-2026-10-30-debb2e` | `sha256:b9548fe8a7668fcfa294a5abb563bf0a` |
| prod | `prod-2026-10-30-3cf2bf` | `sha256:4d4c68f2bc109021152e629a077b7da7` |

```
[Nest] … LOG [auth] ES256 keys: dev-2026-10-30-debb2e (signing) sha256:b9548fe8a7668fcfa294a5abb563bf0a
```

## ES256, and the allowlist

The signature is **ES256** (ECDSA P-256 + SHA-256). OWASP's JWT cheat sheet marks RS256 "not
recommended" (RSASSA-PKCS1-v1_5) and points to ES256, PS256 or EdDSA. Of those three, ES256 has
the widest support across JOSE libraries and gateways, while EdDSA is still patchy in some of
them. It also has a 64-byte signature and a 32-byte key instead of 256 bytes and 2048 bits. It
is asymmetric, so a service that only verifies holds a public key and cannot mint anything.
With HS256 every verifier would hold the signing secret, and any of them could issue itself
`role: admin`.

Verification is `jwt.verify()`, never `jwt.decode()`, with an explicit allowlist:

```ts
jwt.verify(token, key, { algorithms: [ALGORITHM], issuer, audience });   // ALGORITHM = 'ES256'
```

`algorithms` is the one reliable guard against algorithm confusion (RFC 8725 §3.1). Without it the
library would let the token's own header decide, and `"alg": "none"` or an HS256 token "signed"
with the public key would be accepted. The header is read unverified for exactly one thing: its
`kid`, to pick a key from the ring. An unknown `kid` is a 401. `exp`, `iss` and `aud` are checked
by the library; `role`, `sid` and `jti` are then shape-checked; revocation is checked by us.

**Overlap rotation and `kid`.** A token is verified with the key its header names, so two keys can
be valid at once. `node scripts/jwt-keys.mjs rotate <env>` writes a new pair and moves the old
public key to `secrets/jwt/<env>/previous/`. On the next start the API **signs** only with the new
key and **verifies** with both (`JWT_PREVIOUS_*`). Tokens issued before the rotation keep working
until their `exp` and stop then. They cannot outlive one access TTL (10 minutes), after which
`jwt-keys.mjs retire <env>` drops the old key for good. Without `kid` there is no overlap: a
verifier holding two keys would have to try both, and swapping the only key would log out every
user at once. With several instances the order matters. First every verifier learns the new
public key (the one extra slot is for "the other key", incoming or outgoing). Only then does the
signer switch, and the old key is retired one TTL later. Otherwise a token signed by an upgraded
instance would hit one that has never seen its `kid`. Refresh tokens are not affected: they are
opaque, not signed.

## Tokens

| | Access token | Refresh token |
|---|---|---|
| what | JWT, ES256, header `kid` | 32 random bytes, base64url — **not** a JWT |
| lifetime | 10 min (`JWT_ACCESS_TTL_SECONDS`) | 30 days (`REFRESH_TTL_SECONDS`) |
| carries | `sub`, `role`, `sid` (family id), `jti`, `iss`, `aud`, `iat`, `exp` | nothing, it is a lookup key |
| stored by the server | nothing, except a `jti` on the denylist after logout | `HMAC-SHA256(pepper, token)` in `refresh_tokens.token_hash` |
| revoked by | denylist row until `exp` | `revoked_at` on the whole family |

The refresh token is stored as a peppered HMAC, not as itself and not as a bare SHA-256. A dump of
`refresh_tokens` is therefore not a dump of live sessions. Even a dump together with the code is
useless without the pepper, and the pepper lives in the store, not in the database. A bare hash of a
256-bit random string would already resist guessing; the pepper protects against a leak of the
database on its own. Passwords are scrypt with a per-user salt. An unknown email runs the same
scrypt against a dummy hash, so "no such user" and "wrong password" are the same 401 after the
same amount of time.

Logs carry `user`, `family`, `jti` and `token` (the row's UUID) and the key fingerprint, never a
token or any part of one.

## Rotation with reuse detection

RFC 9700 §4.14.2 requires a refresh token for a public client to be either **sender-constrained**
(DPoP, mTLS) or **rotated with replay detection**. This API does the second. Every token of one
login shares a `family_id`. Each row keeps `parent_id`, the token it was exchanged for. That link
exists so that a detected replay leaves a family to revoke.

`POST /auth/refresh` is one transaction:

```
SELECT … FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE      ← two exchanges of one token are serialised
  unknown or expired       → 401
  family revoked           → 401
  used_at already set      → UPDATE … SET revoked_at = now() WHERE family_id = $1   ← reuse: the whole family
                             COMMIT, then 401 and a log line
  otherwise                → UPDATE … SET used_at = now(); INSERT the next token (same family, parent_id = this one)
                             COMMIT, then a new pair; the role is re-read from users
```

A used token that comes back means two parties hold it, and the server cannot tell which one is
the client. So both lose. If the thief refreshed first, the honest client's next refresh is the
replay. It kills the family, including the thief's fresh token. If the client refreshed first,
the thief's replay does the same. Rotation alone, without the family, only refuses the stale
token: the thief who refreshed first keeps a working session, and the honest client is quietly
logged out and logs back in, with nobody any the wiser.

The revocation is committed **before** the 401 is thrown. Throwing inside the transaction would
roll it back and leave the family alive. The log line names the family, never the token:

```
[auth] refresh token reuse detected: token=177451c3-… family=eec04d76-… user=39 — family revoked (2 live token(s))
```

**Two tabs refreshing at once** look exactly like a theft: both send the same refresh token, one
wins, the other is a replay, and the family dies. The choice here is to **serialise the refresh
on the client**: one in-flight refresh promise that every caller awaits. There is no grace window
on the server. A window that returns the same new pair to a second presenter of the same token
for a few seconds is also a window in which a thief who replays fast enough gets that pair. The
`FOR UPDATE` makes the server side deterministic either way: the second exchange always sees
`used_at`.

## Logout is two actions

`POST /auth/logout` (with the access token; it carries its family as `sid`) does two things, in
**one** transaction:

1. `UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $sid` — the refresh token is a
   row the server owns, so marking it is all it takes.
2. `INSERT INTO revoked_access_tokens (jti, expires_at) VALUES ($jti, to_timestamp($exp))` — the
   access token is self-contained. Nothing about it is stored, and it verifies until `exp` no
   matter what happens to the family. The only way to stop it earlier is for every request to
   ask a denylist. The guard does that after the signature check:
   `SELECT 1 FROM revoked_access_tokens WHERE jti = $1 AND expires_at > now()`.

Revoking the family alone would leave the access token working for up to 10 minutes. The
denylist alone would leave the refresh token able to mint new access tokens for 30 days. Those
are two different kinds of token, and each needs its own way of dying.

The denylist lives in **Postgres, next to the family**, not in Redis. Both writes then commit or
roll back together. A denylist in Redis and `revoked_at` in Postgres would be two stores written
one after the other: the dual write of the outbox homework, which no amount of ordering makes
atomic. The cost is one primary-key lookup per authenticated request on a table that holds at
most one access-TTL's worth of logouts. The denylist forgets on its own: `expires_at` is exactly
the token's `exp` (demo:auth checks the difference is 0 s), lookups ignore expired rows, and
every logout deletes them. Not a second longer, and the table never grows.

What logout does **not** kill: an *earlier* access token of the same family, one that was
already replaced by a refresh. The client threw it away, so it lives out its at most 10 minutes
only in the hands of somebody who copied it. Closing that would mean checking `sid` against
revoked families on every request: a second lookup that makes the `jti` denylist redundant. The
same cost/benefit question applies. "A JWT cannot be revoked" is half true; the honest version is
that it can, and the question is what you pay. A short TTL pays in refreshes, a denylist pays in
statelessness, an opaque token pays in an introspection call per request. RFC 7009 §3 puts it in
one sentence: the cost of revocation follows from the security properties you want, not from a
constant.

## 401 and 403

| Situation | Status | Decided by |
|---|---|---|
| no `Authorization`, not `Bearer`, malformed, bad signature, wrong `alg`/`iss`/`aud`, unknown `kid`, expired | 401 + `WWW-Authenticate: Bearer` | `AccessTokenGuard` |
| a valid token whose `jti` is on the denylist | 401 | `AccessTokenGuard` |
| refresh token unknown, expired, used or of a revoked family | 401 | `AuthService.refresh` |
| a valid token, the wrong role (`POST /products` as a buyer) | 403 | `RolesGuard` |
| a valid token, somebody else's order (`GET /orders/{id}`, `PATCH …/status`, `…/events`, WebSocket `join`) | 403 | `access()` after the order is loaded |

`express-openapi-validator` runs with `validateSecurity: false`. The spec declares `bearerAuth`
and documents every 401/403, but the guards are the single place that decides. The validator
still runs first, so a request that breaks the contract is 400 before anyone looks at the token.

## Two levels of authorization, and where ownership is checked

**Role** is a guard: `@UseGuards(AccessTokenGuard, RolesGuard) @Roles('seller', 'admin')` on
`POST /products`. It needs nothing but the token, so it can run before the handler. The order of
the two guards is the order of the two questions: 401 is settled before 403. The new product's
seller is the caller (`sub`), no longer "the first user in the table".

**Ownership is deliberately not a guard.** A guard runs before the handler and has no order
to look at. To learn `buyer_id` it would have to load the order itself, and the handler would
load it again. In this code the boundary is `access(orderId, order, principal)` in
`src/realtime/order-access.ts`, called right after the order is loaded, in the controller for
HTTP and SSE and in the gateway for `join`. For the list, ownership is part of the read itself
(`OrdersService.listFor` filters on `buyer_id`, the in-memory form of `WHERE buyer_id = $1`). An
admin sees every order. The orders of the HTTP API are still the in-memory ones of the contract
homework. With them in Postgres the same rule becomes `WHERE id = $1 AND buyer_id = $2`, and
"found nothing" then splits into 404 or 403 by a second, cheap existence check.

**The role in the token is a cache, not the source of truth.** It is copied from `users.role` at
login and at every refresh, and the guard trusts the copy. An admin demoted in the database
**stays an admin until their access token expires**, for at most `JWT_ACCESS_TTL_SECONDS`
(10 minutes). Their next refresh re-reads `users.role`, and the new token says `buyer`. This
is a deliberate trade: no database read per request for the role, in exchange for a bounded
window. If the window is unacceptable for one specific demotion, revoke that user's families
(their refresh tokens die at once) and let the access token run out, or make the role check read
`users` for admin-only routes.

The other transports follow the same identity. The WebSocket handshake carries the access token
(`io(url, { auth: { token } })`) and it is verified on every `join`, so a token revoked by logout
stops opening rooms on an already-connected socket. The SSE stream takes `Authorization: Bearer`.
The browser `EventSource` cannot send that header, so a browser client uses a fetch-based SSE
reader. A token in the query string would end up in access logs.

## The three runs

Real output, `npm run demo:… ; echo "exit=$?"` (the checks above the `key=value` lines are from the
same run):

```
$ npm run demo:auth
access 2: jti=fa4d9c7a-… family=3fe28289-…, exp in 600 s
family 3fe28289-…: 2 refresh tokens, 0 live
denylist row: expires at the token's exp (+0 s)

  ok    login: 200
  ok    no token is 401: 401
  ok    a valid token is 200: 200
  ok    refresh rotates: 200
  ok    logout: 204
  ok    access after logout is 401 while still unexpired: 401, unexpired=true
  ok    refresh after logout is 401: 401
  ok    denylist TTL = remaining life of the token: 0 s off
  ok    no live refresh token left in the family: 0 live of 2

login=200
no-token=401
with-token=200
refresh=200
logout=204
after-logout=401
refresh-after-logout=401
family-live=0
denylisted=1
exit=0
```

```
$ npm run demo:reuse
family eec04d76-…: 2 tokens, 1 used, 0 live, 1 parent link(s)
api log: [auth] refresh token reuse detected: token=177451c3-… family=eec04d76-… user=39 — family revoked (2 live token(s))

  ok    login: 200
  ok    the first refresh rotates: 200
  ok    the replayed refresh token is refused: 401
  ok    the newest token of the family is dead too: 401
  ok    every token of the family is revoked: 0 live of 2
  ok    old → new link is kept: 1
  ok    the reuse is logged once, with the family id: 1 line(s)

login=200
r1-refresh=200
r1-reuse=401
r2-after-reuse=401
family-tokens=2
family-live=0
reuse-logged=1
exit=0
```

`r1-reuse=401` alone would also come from rotation without a family. `r2-after-reuse=401` is the
line that proves the family: the honest client is out as well. With the revocation commented
out of `AuthService.refresh` the same demo prints `r2-after-reuse=200` and exits `1`. That was
checked by patching the built `dist/auth/auth.service.js`, not just assumed.

```
$ npm run demo:rbac
seller 42 created p_77; buyer 40 ordered it as o_1
/orders/o_1: owner 40 → 200, stranger 41 → 403, no token → 401
forged token (role=admin, old signature): 401, products written: 0

  ok    order belongs to its creator: 201, buyer 40
  ok    no token is 401, not 403: 401
  ok    the owner reads the order: 200
  ok    another buyer is 403, not 404 or 200: 403
  ok    a buyer may not write products: 403
  ok    a seller may: 201
  ok    a forged payload is 401 and writes nothing: 401, 0 row(s)

anon=401
own=200
foreign=403
role-denied=403
role-allowed=201
tampered=401
exit=0
```

`tampered` is the buyer's own access token with `role` rewritten to `admin` in the payload and
the original signature left on. It takes the three lines from the assignment
(`tamper()` in `src/auth/demo-kit.ts`) and no key. A server that decodes instead of verifying
lets it create a product (201). This one answers 401, and the demo also counts that no such
product reached the database.

The seeded fixture accounts (`npm run seed`) now have roles (the four shops are `seller`, the four
people `buyer`) and the dev password `marketplace-dev-password`. It is a fixture of the same kind
as the compose credentials: it opens a local seeded database and nothing else.
`scripts/realtime-demo.mjs` and `npm run smoke` log in with it. The demos above use none of
this; they create their own accounts with random passwords.

The bonus (ReBAC tuples in the style of OpenFGA) is not implemented.

# Files (Файли)

Product photos, avatars and documents. "A folder on the server" breaks at the second instance: the
pod that received a file and the pod that serves it are different machines. Every file now
follows one path: accepted → stored → served. Each step pays for something on purpose, and each
of the three demos proves one claim that is easy to confuse with half of itself:

| Demo | Claim | The half it is not |
|---|---|---|
| `demo:upload` | the bytes go **past** this service | "there is an upload endpoint", which a proxy also has. Here the bytes arrive while the API is switched off |
| `demo:multipart` | multipart is about **resuming** | "big files are supported", which also holds for re-uploading everything after a break. Here one part of three is sent after the break |
| `demo:cdn` | an update needs **no invalidation** | "there is a CDN", which a public bucket also has. Here a direct read is 403, and new content arrives under a new URL |

| Piece | Where |
|---|---|
| intent / parts / commit / download | `src/files/files.service.ts`, `src/files/files.controller.ts` |
| every number: TTLs, threshold, part size, the content-type allowlist | `src/files/upload-plan.ts` |
| the S3 client, `ensureBucket` (+ the lifecycle rule) | `src/storage/s3.ts`, `src/storage/storage.module.ts` |
| the `files` table | `src/migrations/1793351762427-Files.ts`, `src/entities/stored-file.entity.ts` |
| the edge (the cache in front of the bucket) | `src/edge.ts` |
| assets published under a content hash, `Cache-Control: immutable` | `src/files/assets.ts` |
| clients without credentials: a single PUT, a resumable part uploader | `src/files/put-file.ts`, `src/files/part-uploader.ts` |
| the demos and their kit | `src/demo-upload.ts`, `src/demo-multipart.ts`, `src/demo-cdn.ts`, `src/files/demo-kit.ts` |
| the object storage | `storage` in `docker-compose.yml`: RustFS 1.0.4, S3 API on `59000` |

**The storage is RustFS, not MinIO.** MinIO no longer publishes container images (`docker pull
minio/minio` and `quay.io/minio/minio` both fail), and LocalStack's free edition does not
enforce IAM, so an anonymous GET there is not a trustworthy 403. RustFS speaks the same S3 API.
Before writing any code I probed it for every behaviour the demos rely on: presigned PUT and its
expiry, a signature over the path, `ListParts`, `HeadObject` → 404 before `Complete`, the `-N`
ETag, the lifecycle rule, and 403 for anonymous reads. The code only knows an endpoint. With
`STORAGE_ENDPOINT` empty it talks to AWS S3 itself, virtual-hosted style.

## Variables

| Variable | Джерело | Purpose |
|---|---|---|
| `STORAGE_SECRET_KEY` | **secrets store** (#11): `secrets/storage_secret_key` via `STORAGE_SECRET_KEY_FILE` and `with-secrets.sh` | read and write on every file of the bucket |
| `STORAGE_ACCESS_KEY` | **secrets store** (#11): the store's `.env` | the key id of that credential |
| `STORAGE_ENDPOINT` | `.env` / оточення | S3 API address; empty means AWS S3 |
| `STORAGE_BUCKET` | `.env` / оточення | the one bucket, private |
| `STORAGE_REGION` | оточення (default `us-east-1`) | the region requests are signed for |
| `UPLOAD_PUT_TTL_SECONDS` | оточення (default `300`) | lifetime of a presigned single PUT |

No new env file: the storage settings joined `DB_URL` and `BROKER_URL` in the git-ignored `.env`,
and the secret key joined `db_password` in `secrets/`. `STORAGE_SECRET_KEY` has no default, and the
bare `npm run start` names it when it is missing. Its leak costs something different from a leaked
`DATABASE_URL`: it is the right to read and overwrite every file. In production it should not be
the root credential compose uses here, but an IAM role scoped to this bucket (policy below). The
three demos run through `bash scripts/with-secrets.sh dev …`, and `SKIP_VAULT=1` works unchanged. A
CloudFront signing key would be the next secret of this kind, because it grants access to every
private object of a distribution. It is not needed here, see the end of this section.

## The upload: intent → PUT to storage → commit

```
POST /uploads/intent   { filename, content_type, size }   (Bearer, Idempotency-Key)
   allowlist check, key = uploads/{userId}/{uuid}.{ext}, row PENDING
   ≤ 10 MiB → one presigned PUT, Content-Type + Content-Length signed, 5 min
   > 10 MiB → CreateMultipartUpload + one presigned URL per part, 15 min
                │
client ──PUT──► storage                (the API is not on this path)
                │
POST /uploads/commit   { file_id }
   multipart: ListParts → all parts there? → CompleteMultipartUpload
   HeadObject → exists? same size as declared? → COMPLETED, else 409
```

- **The key is the server's.** The extension comes from the allowlist by `content_type` (`jpg`,
  `png`, `webp`, `pdf`, `mp4`), the name is a UUID, and the prefix is the caller's id. The
  client's `filename` is accepted and ignored. If it ever became part of the key, a client could
  write anywhere in the bucket: `../../etc/passwd`, or `uploads/<someone else>/avatar.png`. The
  demo sends exactly `../../etc/passwd`.
- **The signature covers what matters.** Path, `Content-Type` and `Content-Length` are signed. A URL
  with another key in its path is 403 (`SignatureDoesNotMatch`), and so is a PUT of a bigger file
  than declared.
- **The commit trusts the bucket, not the client.** `HeadObject` is the only evidence that bytes
  arrived. Without it a client commits a file it never uploaded, and the database points at
  nothing (`commit-without-bytes=409`). The size is compared too. `Content-Type` is the client's
  claim; a check of the magic bytes (`GetObject` with `Range: bytes=0-255` + `file-type`) would
  go into this same step. It is not done here, and scanning the content is lecture 27's topic.
- **Ownership is in the query**, `WHERE id = $1 AND owner_id = $2`: somebody else's file is a
  404, not a 403, so its existence is not confirmed either. An admin passes.
- **A double tap does not create two uploads.** The intent is idempotent on `Idempotency-Key`,
  per user, the same as `POST /orders`.
- **Downloads go through the API, the bytes do not.** `GET /files/:id` runs the guard and the
  owner check on every call and answers 302 to a presigned GET that lives **60 s**. A presigned
  URL cannot be revoked: it has no `jti` and no registry, so of the revocation strategies of the
  auth homework only "make it short" works. A link in an email therefore points at
  `/files/:id`, never at storage.
- **The list of a user's files lives in Postgres.** Listing a bucket is paid, slow (1 000 keys per
  call) and knows nothing about owners. The demos list only to clean up their own prefix.

Logs carry the file id and the object key, never a presigned URL: a URL in a balancer's access
log is access granted until it expires.

### Why these numbers

| Number | Value | Why |
|---|---|---|
| presigned single PUT | **300 s** | An upload from a form starts right after the intent, and S3 checks the expiry when the request *starts*, not when the last byte lands. Five minutes covers a slow phone and one retry. Longer only means a URL that keeps working after it has leaked. The 7 days SigV4 allows is also a trap: a URL dies with the credentials that signed it, and in production those are a role session (STS, 1 hour by default). |
| presigned part | **900 s** | The parts of one file go one after another, so a URL may wait for its turn. A resumed upload asks for fresh ones anyway (`GET /uploads/:id/parts`). |
| presigned download | **60 s** | Long enough to follow a redirect, too short to be worth stealing. |
| multipart threshold | **10 MiB** = 2 × minimum part | Multipart costs Create + one request per part + Complete. That pays off when a failure would otherwise cost a lot. Below two full 5 MiB parts there is at most one part to keep after a break, so the file goes up in one PUT. Above it, a break costs at most one part. |
| part size | **max(5 MiB, ⌈size / 10 000⌉ rounded up to a MiB)** | S3 allows at most 10 000 parts, and every part but the last must be ≥ 5 MiB, or `Complete` answers `EntityTooSmall`. A hard-coded 5 MiB fails above ~48.8 GiB. At this API's 5 GiB cap the rule still gives 5 MiB (1 024 parts); at S3's 5 TiB object limit it would give 525 MiB. |
| largest upload | **5 GiB** | Photos, documents and short clips. It is also the single-PUT ceiling of S3, so every file stays one object the edge could still serve. |

The S3 documentation lists four benefits of multipart: parallel parts, pausing and resuming,
starting before the size is known, and recovering from a network failure by resending one part.
Only one of the four is about size.

### Orphans and abandoned uploads

The commit step exists because without it there are objects the database does not know about.
Mature systems collect terabytes of those orphan files. Two things deal with what is left behind:

- **The lifecycle rule** `AbortIncompleteMultipartUpload` after 7 days, set by `ensureBucket` on
  every start. An unfinished multipart upload is billed for its parts, does not appear in a
  listing and has no object. "Delete objects older than 30 days" does not touch it, because that is
  a different action.
- **A cleanup job** for `PENDING` rows older than a day: `AbortMultipartUpload` if there is an
  `upload_id`, `DeleteObject`, then delete the row. The partial index
  `idx_files_pending_created_at` exists for it. *Not implemented here.* It would be a BullMQ
  repeatable job, like the scheduler in the Redis homework.

A browser client PUTs across origins, so a real bucket needs a CORS rule: `PUT` from the app's
origin, `Content-Type` allowed, and `ETag` exposed (the multipart client reads it). The demos run in
Node and need none of that.

## The CDN in front of a closed bucket

**Chosen form: local.** `src/edge.ts` is about 60 lines of `node:http`. It is the only reader of
the bucket the public talks to, and it fetches objects **with its own credentials**. It keeps an
object as long as the object's `Cache-Control` allows, and reports `X-Cache: HIT|MISS`. That is
the whole idea of CloudFront Origin Access Control: the cache goes to the bucket, the public goes
to the cache. The bucket itself grants nothing to anyone, and an anonymous GET is 403 (`direct=403`).
The edge serves only `assets/*`. Uploads are private and go through `GET /files/:id`.

The edge caches only what the origin marks `public` with a `max-age`. The header is set **on the
object, when it is uploaded** (`publishAsset`), not in the edge. Without it there is nothing to
cache, and the hit count stays 0.

**Updates without invalidation.** An asset's name contains a hash of its content:
`demo-app.css` → `assets/demo-app.168a61a5.css`. It is uploaded with `Cache-Control: public,
max-age=31536000, immutable`. A new version is a new name. The old cache entry harms nobody,
because no page asks for it any more, and the number of invalidations is zero. AWS says the same
about CloudFront: for files that change often, version the file names first, and invalidate
second. Whatever references the assets (the HTML, a manifest) is the one thing that must not be
cached for long.

**The AWS form** (configuration only; nobody can bring up a live distribution without an
account): CloudFront with Origin Access Control in front of the bucket, Block Public Access on,
and this bucket policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCloudFrontReadOfPublicAssets",
      "Effect": "Allow",
      "Principal": { "Service": "cloudfront.amazonaws.com" },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::marketplace-files/assets/*",
      "Condition": {
        "StringEquals": {
          "AWS:SourceArn": "arn:aws:cloudfront::111122223333:distribution/E2EXAMPLE0ABCD"
        }
      }
    }
  ]
}
```

The `Condition` is not optional. Without `AWS:SourceArn` the statement allows *every* CloudFront
distribution in the world, anyone's, to read the bucket. `Resource` is `assets/*` only: user
uploads are never readable by the CDN. On the CloudFront side the cache policy honours the origin's
`Cache-Control`. The API itself runs under a role allowed `s3:PutObject`, `s3:GetObject`,
`s3:AbortMultipartUpload` and `s3:ListMultipartUploadParts` on `arn:aws:s3:::marketplace-files/uploads/*`
(and `s3:PutObject` on `assets/*` for the publishing step), and nothing else.

**Private content through the CDN** would be CloudFront signed URLs or signed cookies, with the key
pair in the store next to the JWT keys. It is not needed for public assets and not done here; user
files keep going through `GET /files/:id` → presigned GET.

## The three runs

Real output (`npm run demo:… ; echo "exit=$?"`):

```
$ npm run demo:upload
intent: filename "../../etc/passwd" → key uploads/49/391f4b5c-047d-4e91-875a-8292b3cf899b.png
API on :58898 stopped (alive=0); PUT from a process with env = { PATH }
API back on :58912 (a different port), presigned PUT TTL 2 s
the same URL 5 s after a 2 s expiry → 403
GET /files/391f4b5c-… → 302 → presigned GET → 200, same bytes: true
  … every invariant ok …
intent=200
key-from-server=1
api-alive=0
put-offline=200
commit=200
commit-without-bytes=409
tampered=403
expired=403
download=302
exit=0
```

`api-alive=0` + `put-offline=200` is the pair that matters. The API's port is checked with a raw
`net.connect`, not `fetch`, because fetch keeps a connection pool per host and port. The PUT then
comes from a separate process whose whole environment is `PATH`: no storage key, no token, no
database. A design that proxies the file through the backend prints `put-offline=0` here. The
API comes back on a **different** port, because the same port would meet a dead keep-alive socket
in fetch's pool. This second instance runs with `UPLOAD_PUT_TTL_SECONDS=2`, so `expired` is a URL
the API itself signed, used five seconds later. The extra seconds cover clock drift between the
host and the container.

```
$ npm run demo:multipart        # run twice in a row, the same output both times
intent: 12582912 bytes → multipart, 3 parts of 5242880
uploader #1: sent 2 part(s), ended by SIGKILL
storage: 2 part(s) of the upload, HeadObject on the key → 404
uploader #2: storage already had parts [1,2], sent [3]
complete: 12582912 bytes, ETag c7a1c909f1b5c27cafd503dbfb90f630-3, MD5 of the file f0a81e3f49237724fe40ccfab1c940eb
  … every invariant ok …
parts-planned=3
parts-before-crash=2
head-before-complete=404
resumed-parts=1
complete=200
size-match=1
etag-multipart=1
etag-is-md5=0
exit=0
```

Both uploaders are the same script (`part-uploader.js`) with the same environment: `PATH` and the
caller's access token, no storage credentials. The first is killed with `SIGKILL` right after its
second part, so nothing in its memory survives. The second process knows nothing about it. It asks
`GET /uploads/:id/parts`, the API asks the bucket (`ListParts`), and it sends only part 3. Before
`Complete` the parts exist and the object does not (`HeadObject` → 404). After it the size
matches, and the ETag ends in `-3` and is not the file's MD5: code that compares an ETag to a
local MD5 silently breaks on every multipart object. The demo aborts unfinished uploads and
deletes the object both before and after itself. Without that, the second run would see the first
run's object and print `head-before-complete=200`.

```
$ npm run demo:cdn
v1 → assets/demo-app.168a61a5.css; anonymous GET to the bucket → 403
edge: assets/demo-app.168a61a5.css → 200 MISS, then 200 HIT (Cache-Control: public, max-age=31536000, immutable)
deploy v2 → assets/demo-app.c99d4cec.css; edge → 200 MISS; the old URL → 200 HIT
  … every invariant ok …
direct=403
edge-miss=200
edge-hit=200
cache-hit=1
new-name=1
new-url=200
content-changed=1
old-url-hit=1
exit=0
```

`old-url-hit=1` is the other half of "no invalidation". The old entry was never purged, and it does
not need to be.

**What this homework closes from the pooling one (#15):** the nightly `pg_dump` now has a natural
destination, a bucket with a lifecycle rule moving old dumps to a colder class. Two honest caveats.
Glacier-class storage breaks the RTO, because an object has to be restored before it can be read.
And a lifecycle rule does not make a backup verified; the restore drill stays.

The same idea runs through all three mechanisms. A presigned URL cannot be revoked, so it is short.
A CDN entry cannot be recalled, so the URL is versioned. A broken connection cannot be prevented,
so the upload is resumable. When undoing something is expensive or impossible, arrange things so
that it never needs undoing.

# Kubernetes: a rollout under load (Kubernetes: викочування під навантаженням)

On homework 05 the question was whether the image starts. Here it is whether a new revision rolls
out under load without a single request going unanswered. The answer is the `failed=` line of
`npm run demo:rollout`, counted from a file with one line per response. Nothing in it is typed in
by hand.

```
docker/Dockerfile           4 stages; the last is gcr.io/distroless/nodejs22-debian12:nonroot, uid 65532
k8s/kind-config.yaml        one kind node, NodePort 30080 mapped to 127.0.0.1:30080
infra/                      Pulumi (TypeScript): Namespace, Secret, Deployment, Service, PDB, HPA
                            (+ coursework: Postgres, RabbitMQ, migrate Job, relay, consumer)
scripts/with-secrets.sh     the store from #11 → DB_PASSWORD, PULUMI_CONFIG_PASSPHRASE
scripts/pulumi.sh           up | preview | destroy against a local file backend
scripts/load.mjs            load generator: one status code per line, 000 for no response
scripts/scan.sh             Trivy report → found vs SCAN_MAX → gate=pass|fail
demo/image.sh, rollout.sh, pdb.sh
.github/workflows/build.yml build → push → demo:image → scan with the working threshold (HW-32: the one build of the pipeline)
```

## Kubernetes

### What runs in the pod

*Since the coursework the Deployment runs `dist/main.js` with Postgres, RabbitMQ, the relay and
the consumer next to it ([Kubernetes: the full contour](#kubernetes-the-full-contour)). This section
describes homework 28's stub, which is still in the image as `dist/k8s-pod.js`.*

The image is the whole application: `dist/main.js` and everything it needs are inside. The
Deployment runs `dist/k8s-pod.js` from the same image. The full API needs Postgres, Redis, RabbitMQ
and object storage, and a one-node cluster on a laptop runs none of them. `k8s-pod.js` is the
stateless HTTP side of the service and shows the three behaviours this homework measures:

| Endpoint | Answers | Question |
| --- | --- | --- |
| `GET /healthz` | 200 while the event loop turns | should this pod be killed? (livenessProbe) |
| `GET /readyz` | 200 only after the warm-up and before SIGTERM, 503 otherwise | may it get traffic? (readinessProbe) |
| `GET /` | `{rev, pod, pid}` | the work itself; the load generator calls this |

The process waits `WARMUP_MS` = 4 s before `listen()`, standing in for migrations and a pool.
Without that pause the broken profile would show zero failures, because the app would start faster
than the rollout could break it. On SIGTERM the steps run in this order:

1. `/readyz` turns 503 at once.
2. The pod keeps serving for `DRAIN_MS` = 5 s. Each response in that window carries
   `Connection: close`, so keep-alive clients reconnect, and kube-proxy sends the new connection
   to another pod.
3. Only then does `server.close()` run. Idle sockets are closed at once and the rest after 2 s.

If it called `close()` first, the pod would refuse connections that kube-proxy is still sending to
it. `terminationGracePeriodSeconds` is 15, which is more than 5 + 2, so SIGKILL never lands in the
middle of the drain. The process also refuses to start without `DB_PASSWORD` and names the variable.

### The cluster, and how much memory it got

**kind v0.33.0 (node image Kubernetes v1.37.0), one node, on Docker Desktop with 7.65 GiB and 8
CPUs.** With the three API pods running after the rollout demo, `docker stats` showed the kind
node at **≈ 950 MiB**. `npm run cluster:up` took 74 s the first time, because it pulled the node
image, and 34 s after that, image load included. kind has no memory flag of its own; the node takes what Docker Desktop allows. kind
was chosen over minikube because it is lighter and because minikube refuses to start with less
than 1800 MB.

### Variables

| Variable | Source | Purpose |
| --- | --- | --- |
| `DB_PASSWORD` | **сховище** (#11): `secrets/db_password`, exported by `with-secrets.sh` | the database password; Pulumi puts it into the K8s Secret `marketplace-api-secrets`, and the pods read it as a file (`DB_PASSWORD_FILE`) |
| `BROKER_PASSWORD`, `STORAGE_SECRET_KEY`, `JWT_*`, `REFRESH_TOKEN_PEPPER`, `PAYMENT_WEBHOOK_SECRET` | **сховище**: the same files the API reads locally, exported by `with-secrets.sh` | added by the coursework: the same Secret, the same file mount |
| `PULUMI_CONFIG_PASSPHRASE` | **сховище** (#11): `secrets/pulumi_passphrase`, exported by `with-secrets.sh` | encrypts the Pulumi state, which holds the Secret's value |
| `PULUMI_BACKEND_URL` | process environment; `scripts/pulumi.sh` defaults it to `file://<repo>/.pulumi` | a local file backend, never a `pulumi login` to an account |
| `ROLLOUT_PROFILE` | process environment, set by `demo:rollout` | `safe` (default) or `broken` |
| `APP_REV` | process environment, set by `demo:rollout` | `REV` in the pod template; a plain `up` keeps the running one |
| `SCAN_MAX`, `SCAN_SEVERITY`, `SCAN_FIXABLE` | process environment | the scan gate: ceiling, severities, fixable only |

No new env file was added. The value travels this way:

```
store (.env + secrets/db_password)  →  with-secrets.sh  →  DB_PASSWORD
  →  Pulumi (pulumi.secret, Secret.data base64)  →  Secret marketplace-api-secrets
  →  volume /run/secrets/app/DB_PASSWORD  →  DB_PASSWORD_FILE  (homework 28: secretKeyRef → env)
```

The Deployment manifest carries only the reference, never the value. The first thing
`infra/index.ts` does is validate its config. Without `DB_PASSWORD`, `pulumi preview` and
`pulumi up` exit 1 with `DB_PASSWORD is not set — …`, before any provider is reached. Without
`PULUMI_CONFIG_PASSPHRASE`, Pulumi itself fails and names it. The program has no fallback such as
`?? "changeme"`.

The Secret is written as `data` (base64), not `stringData`. `stringData` is write-only, so the API
never returns it and every `up` would show a diff. With `data`, two `up` runs in a row report
`8 unchanged`. Don't run `pulumi refresh` on this stack: it drops the Secret from the state, and
the next `up` then fails with `already exists`.

Base64 is not encryption. In this local cluster the value sits in etcd as plain text, because no
encryption-provider-config is set. Putting the password in a Secret takes it out of git; it does
not encrypt it. The BuildKit secret further down is a different thing with a different job. It
exists only during `docker build` and keeps the registry token out of the image. The K8s Secret
exists at runtime and keeps the database password out of the repository. Both are needed, and
neither one replaces the other.

**In a production cluster** Pulumi would not be the one to carry the value. There are two common
ways to do it. The **External Secrets Operator** runs in the cluster, reads the secret from
Vault, AWS Secrets Manager or GCP Secret Manager, and keeps a normal K8s Secret in sync with it.
The Deployment's `secretKeyRef` stays the same, rotation happens in the store, and Pulumi state
never sees the value. The **Secrets Store CSI driver** mounts the secret from the provider as a
volume when the pod starts. If it is set up without the optional sync to a K8s Secret, the value
never reaches etcd at all. Neither one is installed here; the homework only asks for them to be
named.

### The image

`docker/Dockerfile` has four stages: `deps`, then `build`, then `prod-deps`, then `runtime`. The
builders are `node:22-bookworm-slim` and the runtime is `gcr.io/distroless/nodejs22-debian12:nonroot`.
Both are Debian 12, so a native module built in one loads in the other. The runtime has no shell and
no package manager, and it runs as `USER 65532:65532`. The user is given as a number on purpose:
`USER nonroot` combined with `runAsNonRoot: true` fails with "image has non-numeric user (nonroot),
cannot verify user is non-root", because kubelet does not resolve names. Distroless is not here to
save size; the image is 360 MB, mostly `node_modules`. The point is that after an RCE an attacker
finds no `sh`.

The npm registry token is a BuildKit secret, `RUN --mount=type=secret,id=npm_token`. It is written
into a temporary `.npmrc` and deleted again inside the same `RUN`, so it never ends up in a layer.
It is scoped to `@marketplace-private` on `npm.pkg.github.com`. That registry is not used, which
makes `.npm_token` a decoy, and the public registry never sees the token. The two other ways to pass
it both leak:
an `ARG` ends up in `docker history`, and `COPY` followed by `rm` leaves the bytes in the earlier
layer with only a whiteout on top. `demo:image` checks all three places, because no single tool sees
both leaks. To make sure it really catches them, it was run against a deliberately leaky image (an
`ARG` plus `COPY .npm_token` and then `rm`), which gave:

```
shell-inside=1  runtime-uid=0  token-in-history=3  token-in-config=0  token-in-layers=1
```

The real image gives:

```
$ npm run demo:image
image=marketplace-api:1.0.0
layers-searched=24
stages=4
shell-inside=0
runtime-uid=65532
token-in-history=0
token-in-config=0
token-in-layers=0
```

`shell-inside` comes from actually trying `docker run --entrypoint sh|/bin/sh|/busybox/sh`, not
from reading the Dockerfile. `runtime-uid` is what `process.getuid()` returns inside the image when
it starts the default way. `token-in-layers` is found by unpacking `docker save` and reading every
layer listed in `manifest.json`, whether it is a plain tar, gzip or zstd.

### The scan gate

`npm run scan` runs Trivy on the image (the local `trivy` binary, or `aquasec/trivy:0.76.2` when
none is installed). It counts the CRITICAL and HIGH findings that already have a fixed version,
and compares the count with `SCAN_MAX`:

```
$ SCAN_MAX=-1 npm run scan;    echo "exit=$?"     # found=21 max-allowed=-1    gate=fail  exit=1
$ SCAN_MAX=99999 npm run scan; echo "exit=$?"     # found=21 max-allowed=99999 gate=pass  exit=0
```

The verdict is worked out from the report. A scan that could not run at all prints `gate=error` and
exits 2, because an empty report does not mean a clean image. Of the 21 findings on 2026-11-16, 7
are `libssl3` in the distroless base and the rest are npm packages: `multer`, which comes with
`@nestjs/platform-express`, plus `body-parser`, `fast-uri` and `lodash`. The working threshold is
`SCAN_MAX=25` (the script's default and `.github/workflows/build.yml`). It is a ceiling the team
raises or lowers on purpose, through `vars.SCAN_MAX`. It is not a promise that the image stays
green, because the scanner's database changes every day.

### The rollout

| Setting | safe | broken |
| --- | --- | --- |
| `strategy.rollingUpdate` | `maxUnavailable: 0`, `maxSurge: 1` | `maxUnavailable: 1`, `maxSurge: 1` |
| readinessProbe | `/readyz`, every 1 s, 1 failure | none |
| livenessProbe | `/healthz`, every 10 s, 3 failures, from 10 s | none |
| `DRAIN_MS` | 5000 | 0 (closes on SIGTERM) |
| `terminationGracePeriodSeconds` | 15 | 15 |

Liveness and readiness use different paths on purpose. A pod that is warming up or draining is not
ready, and that is expected. If liveness pointed at `/readyz`, every drain would turn into a restart
and a slow start would turn into a restart loop. The liveness probe starts late (10 s) and gives up
slowly (3 × 10 s), because a bad liveness probe is worse than none.

`demo:rollout` first brings the Deployment to the chosen profile at its current revision and waits
until it settles. Then it starts the load and lets 3 s of baseline run. Then it runs `pulumi up` with
`APP_REV + 1`. A change to the pod template is what starts a rollout; a rebuilt image under the same
tag would change nothing that Kubernetes can see. The load keeps going until only new pods are left,
all of them ready, plus 2 s. `rollout-seconds` runs from the creation of the new ReplicaSet to the
moment that the last old pod is gone, drain included. A broken run puts the safe profile back on its
way out.

```
$ npm run demo:rollout
# code 200: 286474
profile=safe
keepalive=1
rev-from=1
rev-to=2
requests=286474
ok=286474
failed=0
rollout-seconds=23
```

| Run | Profile | Client | requests | failed | rollout-seconds |
| --- | --- | --- | ---: | ---: | ---: |
| 1 | safe | keep-alive, 16 in flight | 286 474 | **0** | 23 |
| 2 | safe | keep-alive, 16 in flight | 284 597 | **0** | 22 |
| 3 | safe | keep-alive, 16 in flight | 312 488 | **0** | 22 |
| 4 | safe | new connection per request, 300/s | 8 221 | **0** | 22 |
| 5 | broken | keep-alive, 16 in flight | 54 479 | 20 (all `000`) | 2 |
| 6 | broken | keep-alive, 16 in flight | 52 420 | 3 150 (≈ 6 %) | 2 |
| 7 | broken | new connection per request, 300/s | 1 877 | 54 (all `000`, ≈ 3 %) | 2 |

The safe profile gave zero failures on every run. The broken one fails every time, but how many
requests fail swings widely from run to run (20 and 3 150 on the same settings), and it also depends
on the client. With keep-alive at about 6 000 req/s, most requests stay on
connections to old pods that are still alive, so the few seconds of breakage are a small share of
a large count. At a fixed 300 req/s with a new connection for each request, the share is closer to
a few percent. That is still well below the "one request in six" from the lecture, which used curl
through a different path. The failures appear as `000` (no response) and not as 5xx, because the
client talks to the NodePort directly and nothing in between turns a refused or reset connection
into a 502. The safe profile takes about ten times as long. `maxUnavailable: 0` keeps each old pod
until its replacement has warmed up (4 s) and turned ready, and the drain adds up to 5 s for every
old pod.

There is one trap in measuring this on macOS. Without keep-alive and with no rate limit, the first
version of the generator showed 16 398 failures on the **safe** profile. The cluster was not the
cause. Every request leaves a host socket in TIME_WAIT for 2 × MSL = 30 s, macOS has 16 383
ephemeral ports, and so above roughly 540 new connections per second the host runs out of ports
(`EADDRNOTAVAIL`). A steady cluster with no rollout at all showed the same thing: 12 166 sockets in
TIME_WAIT after 10 s at 1 200 req/s. That is why `scripts/load.mjs` uses keep-alive by default and
gets `--rate` (300/s by default) with `LOAD_KEEPALIVE=0`.

### The PodDisruptionBudget

The PDB uses `maxUnavailable: 1` rather than `minAvailable`. The reason is that `maxUnavailable: 1`
stays "one pod at a time" whatever the HPA does to the replica count, while `minAvailable: 2` turns
into a budget that blocks every drain once the HPA scales down to 2. With three replicas,
`disruptionsAllowed` is 1:

```
$ kubectl -n marketplace get pdb marketplace-api -o jsonpath='{.status.disruptionsAllowed}{"\n"}'
1
$ npm run demo:pdb
replicas=3
healthy=3
minAvailable=2
disruptions-allowed-before=1
evict-1=201
evict-2=429
```

Both evictions go through the Eviction API, which is the path `kubectl drain` uses. The codes are
the HTTP statuses of the two `POST …/pods/<name>/eviction` requests, sent through `kubectl proxy`.
(`kubectl create --raw … -o json` is no use here, because kubectl 1.33+ rejects `--raw` together
with `--output`.) A plain `kubectl delete pod` never asks the PDB at all; this is how PDBs are
defined to work, not a bug. `minAvailable=` is the PDB's `status.desiredHealthy`, which is what
`maxUnavailable: 1` works out to at three replicas. The demo spends the budget and then waits for
the Deployment to recover, so `disruptionsAllowed` should be read **before** it runs.

### replicas vs HPA

The HPA is `autoscaling/v2` with `minReplicas: 2`, `maxReplicas: 6` and a CPU target of 70 %. kind
has no metrics-server, so the HPA shows `cpu: <unknown>/70%` and never scales anything. That is why
`spec.replicas: 3` stays in the program. In a production cluster with metrics-server this becomes a
field-ownership conflict: two writers, the program and the HPA (through the scale subresource),
both own `spec.replicas`. The HPA scales the Deployment to, say, 5. The next `pulumi up` applies
`replicas: 3` with server-side apply and takes the field back, which kills two pods that were
handling load. The HPA then scales up again. The fix is to let the HPA be the only writer. Once the
HPA is active, remove `replicas` from the Deployment (or use `ignoreChanges: ["spec.replicas"]`)
and let `minReplicas` act as the floor.

### Not done

There is no `startupProbe` (the bonus). The 4 s warm-up is short and steady, and readiness already
covers it. Liveness starts at 10 s, which is longer than the warm-up. There is no sidecar either.

# Observability: logs, metrics, traces (Обсервабельність)

The question for this homework: one request at 03:15 returned 500. How long does it take to say
what happened? With this in place it takes one key. The `trace_id` of the failing request is in
its log line, and the same id opens its trace in Jaeger. The trace shows which span failed and
why. The RED dashboard shows whether it was one request or a trend.

Each demo proves exactly one claim and computes its numbers rather than printing them:

| Demo | Claim | How it would fail |
|---|---|---|
| `demo:logs` | the correlator lives in the **context**, not in arguments: 10 parallel requests do not mix, and the deepest layer has the same id | a "current request" in a module variable gives `burst-trace-ids=3 burst-uneven=2` (measured, below) |
| `demo:metrics` ⭐ | the label set is **bounded**: a hundred different ids add no time series | `route` from the raw path: `series-before=5 series-after=105` (measured, below) |
| `demo:trace` ⭐ | **one key opens both doors**: the trace_id in the log line = the trace_id of the span = the one that came in `traceparent` | an own uuid in the logs gives `trace-matches-log=0` |

| Piece | Where |
|---|---|
| OpenTelemetry SDK: http, express, pg instrumentation, OTLP/HTTP exporter, batching | `src/observability/tracing.ts`, the first import of `src/main.ts` |
| the request context in AsyncLocalStorage (`userId`, `tenant`, `idempotencyKey`, demo fault) | `src/observability/context.ts`; `userId` is bound by `AccessTokenGuard` (`src/auth/guards.ts`) |
| pino: JSON on stdout, `trace_id`/`span_id` from the active span in `mixin`, `redact` | `src/observability/logger.ts` |
| Nest's own lines through the same pino | `src/observability/nest-logger.ts` |
| the RED registry: counter + histogram, buckets | `src/observability/metrics.ts` |
| the middleware: one request line + one counter/histogram observation per request, `GET /metrics` | `src/observability/request-log.ts`, wired in `src/bootstrap.ts` |
| a manual span (`orders.place`) | `src/observability/span.ts`, used by `src/orders/orders.service.ts` |
| the stand: Prometheus, Jaeger, Grafana, provisioned datasources, dashboard as JSON | `observability/` |
| the three demos and their kit | `demo/logs.mjs`, `demo/metrics.mjs`, `demo/trace.mjs`, `demo/lib/observed-api.mjs` |

The endpoint is the checkout, `POST /orders` (homeworks 14/22), on the real application:
`dist/main.js`, the same entry point as `npm run start`. Each demo starts it as a child process
on port **22910**. That is the port Prometheus scrapes, so the dashboard fills with the demo's
traffic while it runs. Each demo also resets its own buyer and seller (new password every run)
and recreates the product. A fresh process means fresh counters, so every demo starts from
zero. The demos read the child's stdout and stderr line by line, and the process is always
killed on the way out, including on Ctrl-C.

## Observability

### The stand

`observability/compose.yml` is a separate compose project (`marketplace-observability`). It can be
brought up, measured and removed without touching the database:

| Service | Image | Port (127.0.0.1) | Role |
|---|---|---|---|
| Prometheus | `prom/prometheus:v3.5.0` | 22901 | scrapes `host.docker.internal:22910/metrics` every 5 s |
| Jaeger | `jaegertracing/jaeger:2.10.0` | 22918 (OTLP/HTTP), 22904 (UI + `/api/traces`) | trace receiver and query API in one process, in memory |
| Grafana | `grafana/grafana:12.1.1` | 22903 | datasources and the dashboard provisioned from files; no anonymous access |

I picked Jaeger and Prometheus as separate containers over the single `grafana/otel-lgtm` image.
They are lighter, and this needs neither Loki nor an OTel Collector: logs go to stdout and
metrics are scraped. I measured `docker stats --no-stream` on Docker Desktop (7.65 GiB):

| | Grafana | Prometheus | Jaeger | stand total |
|---|---|---|---|---|
| right after `up --wait` (8 s from nothing) | 105.1 MiB | 19.7 MiB | 13.8 MiB | **138.6 MiB** |
| after 3 × 3 demo runs | 94.8 MiB | 30.5 MiB | 38.3 MiB | **163.6 MiB** |

The API's own dependencies (Postgres 65 MiB, PgBouncer 6 MiB, RustFS 210 MiB) add about 280 MiB.
The kind node of homework 28 was ≈ 950 MiB with three API pods. All of it together is
≈ 1.4 GiB of 7.65 GiB, so the stand fits next to the cluster. The container clock matches the
host clock (`date +%s` vs `docker run --rm alpine:3.20 date +%s`: 1794835966 / 1794835967, the
same second within the time `docker run` itself takes).

### Variables

| Variable | Джерело | Purpose |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | **сховище** (#11): the store's `.env` → `with-secrets.sh` | OTLP/HTTP of Jaeger, `http://127.0.0.1:22918`; the exporter appends `/v1/traces`. Unset: spans are still created (the logs keep their `trace_id`), just not exported |
| `PROMETHEUS_URL` | **сховище** (#11): the store's `.env` | `demo:metrics` asks it whether it scraped the run (informational line) |
| `TRACE_API_URL` | **сховище** (#11): the store's `.env` | Jaeger's query API; `demo:trace` reads the trace from it |
| `GRAFANA_URL` | **сховище** (#11): the store's `.env` | the dashboard, for a human and for `curl` |
| `GRAFANA_ADMIN_USER` | **сховище** (#11): the store's `.env` | interpolated by `observability/compose.yml` (default `admin`) |
| `GRAFANA_ADMIN_PASSWORD` | **сховище** (#11): `secrets/grafana_admin_password`, exported by `with-secrets.sh` | interpolated by `observability/compose.yml`; **no default**: without it compose refuses to start and names the variable |
| `LOG_LEVEL` | `.env` / оточення (default `info`) | the demos run the API with `debug`: the repository layer logs at debug |
| `OTEL_SERVICE_NAME` | оточення (default `marketplace-api`) | `service.name` of the spans and `service` of the log lines |
| `OTEL_BSP_SCHEDULE_DELAY` | оточення (default 1000 ms) | batch export interval; the demos use 200 |
| `FAULT_INJECTION` | оточення, set by the demos for their child only | enables `X-Fault: slow\|error`; off in every other start |
| `OBS_APP_PORT` | оточення (default 22910) | the port the demos start the API on; Prometheus only scrapes 22910 |

No new env file was added. The addresses joined `DB_URL` and `STORAGE_*` in the git-ignored `.env`,
and the Grafana password joined `db_password` in `secrets/` (with `secrets/grafana_admin_password.example`
next to it). Every npm script that needs any of them goes through `bash scripts/with-secrets.sh dev …`:
the three demos, `obs:up` and `obs:down`. `SKIP_VAULT=1` works unchanged. The OTel variables are not
in the zod schema (`src/config/env.schema.ts`) because they are read by `tracing.ts` before the schema
runs. `.env.example` documents them in a commented block, as it already did for `BROKER_URL` and
`REDIS_URL`.

### Logs: one JSON object per line, the correlator from the context

```json
{"level":"info","time":"…","service":"marketplace-api","layer":"products.repo",
 "trace_id":"796559d5…3ae8","span_id":"1070cbb1a4f70047","userId":"73","tenant":"demo-tenant",
 "idempotencyKey":"obs-…","productId":"7","found":true,"msg":"product loaded"}
```

- **The correlator is the trace_id of the active OpenTelemetry span**, read in pino's `mixin` on every
  line with `trace.getActiveSpan()?.spanContext().traceId`. There is no uuid of my own. A second id
  would be one that no trace backend can find.
- **`userId`, `tenant`, `idempotencyKey` live in an AsyncLocalStorage** that the first middleware
  enters (`requestContext()` in `src/bootstrap.ts`). `AccessTokenGuard` adds `userId` once the token
  is verified, and the mixin reads all three. No function takes `req` in order to log. The repository
  that logs `product loaded` has no idea there is an HTTP request.
- **The component** is `layer` (`layerLogger('orders.repo')` = `logger.child({ layer })`). One
  checkout passes `orders.controller` → `orders.service` → `products.repo`, and then `http` writes
  the request line. That makes 4 layers with one trace_id. A failing one adds `http.problem`, the
  line of the exception filter.
- **Everything is JSON**, including Nest's own startup lines (`NestPinoLogger`) and the pool's error
  handler. There is one exception: `Startup aborted.` on a broken configuration. That process never
  serves a request, and its reader is a person looking for the name of a variable. pino-pretty is
  not a dependency. For reading locally: `npm run start:vault | npx pino-pretty`.
- **Redaction** (`REDACT_PATHS` in `src/observability/logger.ts`) covers `req.headers.authorization`,
  `req.headers["proxy-authorization"]`, `req.headers.cookie`, `req.headers["x-api-key"]`,
  `req.body.password`, `req.body.refresh_token`,
  `req.body.access_token`, plus the same three fields at the top level and one level down
  (`*.password`). The paths are written out, because **redact does not guess**. `*.password` hides
  `body.password` but not `body.account.password`: a nested object with no path of its own goes
  into the log as it is. A new field that holds a secret means a new line in that list. The request
  line logs the parsed body on purpose, so you can see that the password is hidden and the rest of
  the body is not. That includes the email of a login, which is personal data: in production
the body would go to debug level, or into the redact list too.

**What I measured about the "ALS gets lost on callbacks" hint.** At first I bound the body parser's
`next()` and the `'finish'` listener with `AsyncResource.bind`. Then I removed both and sent a
checkout whose body arrived in two chunks 300 ms apart. On Node 24.16 and on Node 22.23 (the
version of the production image, run in `node:22-alpine`), every line, the request line included,
still had the user, the key and the trace. Express runs the chain inside `storage.run()`, and those
events fire within it, so these two binds guarded against nothing and were removed.

The place where it **is** lost on this path is a request the client abandons. The request line also
listens for `'close'` (see Metrics below). After an abort, `'close'` is emitted by the socket being
torn down, outside the request's context. I measured it with a checkout under the slow fault and
the client giving up after 200 ms. The line kept its `trace_id`, because OpenTelemetry binds the
response emitter to its own context, but `userId` was gone. Since `AsyncResource.bind(record)`, the
same line has both. Other places of the same kind: the wait queue of a pool, a listener registered
once at startup, a BullMQ worker. The burst demo is the check that would catch one of them on the
checkout path.

Also measured: **without an exporter, NodeSDK 0.301 registers no TracerProvider at all**. It falls
back to the API's no-op tracer, and every line gets `trace_id=00000000000000000000000000000000`. I
found this by running the API without `OTEL_EXPORTER_OTLP_ENDPOINT`. Since then `tracing.ts` passes
a `NoopSpanProcessor` when no endpoint is set, so spans exist and are dropped.

### Metrics: RED

```
http_requests_total{method, route, status}                  counter
http_request_duration_seconds_bucket{method, route, status, le}   histogram
```

`route` is the **template** Express routed to: `req.baseUrl + req.route.path`, so `/orders/:orderId`.
If the OpenAPI validator answered before routing (a 400), it is the template the validator matched
(`req.openapi.expressRoute`). If nothing matched at all, it is `unmatched`, one value for any path.
`status` is the HTTP code that was sent, and `method` is the verb. A request the client abandoned
before any response gets `499` (nginx's "client closed request"), and the line says
`request aborted by the client`. An SSE stream whose tab was closed keeps the `200` it had already
sent. Both are recorded on `'close'`, because `'finish'` never fires for them, and a guard stops
`'close'` after `'finish'` from counting a request twice. The middleware sits before the
body parser, so a 400 for malformed JSON is counted too, as `route="unmatched"`, because nothing
was routed yet. `/metrics` is registered ahead of
everything else, so it is not counted, logged, traced or validated: a scrape is not traffic. This
is a Histogram, not a Summary, because a Summary's quantiles cannot be aggregated across instances.
`/metrics` is on the API's own port with no authentication. That is fine for this stand, but in
production it would move to a separate port that only the cluster network reaches, because the
default metrics expose heap, event-loop lag and the Node version to anyone who can reach the API.

**Buckets** (seconds): `0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10`.

- The **top finite bucket is 10 s**. The slowest thing this service does on purpose is the
  slow-database fault, `pg_sleep(1.2)`, measured at 1218–1224 ms end to end. A cold pool adds a few
  hundred ms. 10 s leaves headroom for a database under load and is past the point where a client
  times out and retries. Above the top bucket everything lands in `+Inf`, and `histogram_quantile()`
  then returns the top bucket's bound, which is a flat, healthy-looking line exactly when things are
  worst. `demo:metrics` checks `above-top-bucket=0` against the top bucket the code defines.
- The steps are **dense below 0.5 s**, because that is where a healthy API is. Measured over one
  `demo:metrics` run from Prometheus: p50 of a successful checkout ≈ 6.5 ms, and every fast
  checkout under 50 ms.
- The slow requests land in the 2.5 bucket, and the failures, which are fast, land low. p99 of
  `POST /orders` on the dashboard is ≈ 2.4 s. That is linear interpolation inside the 1–2.5 bucket,
  not a measurement (the real value is 1.2 s), and it is why bucket bounds near the real latencies
  matter.

### The dashboard

`observability/grafana/dashboards/marketplace-red.json` is provisioned by
`observability/grafana/provisioning/dashboards/dashboards.yml`. The datasources (Prometheus uid
`prometheus`, Jaeger uid `jaeger`) are provisioned by `…/datasources/datasources.yml`, so a fresh
Grafana opens the dashboard with data. It is at `http://127.0.0.1:22903/d/marketplace-red`, behind
the admin login from the store. It has three panels for the three RED questions, each with
`[1m]`, because a demo lasts about a minute:

| Panel | RED question | PromQL |
|---|---|---|
| Rate | how many requests per second, per route? | `sum by (method, route) (rate(http_requests_total{job="marketplace-api"}[1m]))` |
| Errors | which share of them ends in 5xx? | `sum by (method, route) (rate(http_requests_total{job="marketplace-api", status=~"5.."}[1m])) / sum by (method, route) (rate(http_requests_total{job="marketplace-api"}[1m]))` |
| Duration | how long do they take (p50/p95/p99)? | `histogram_quantile(0.99, sum by (le, method, route) (rate(http_request_duration_seconds_bucket{job="marketplace-api"}[1m])))`, and the same with 0.95 and 0.50 |

4xx is left out of Errors on purpose. It is the client's mistake: a 401 without a token or a 404 for
a stranger's order is the API working correctly.

### Traces

`src/observability/tracing.ts` is the first import of `src/main.ts`. Instrumentation patches `http`,
`express` and `pg` as they are required, so whatever was loaded before `sdk.start()` stays
unpatched. Express middleware spans are turned off (`ignoreLayersType: [MIDDLEWARE]`). They added
a dozen spans per request that answer no question, while the route handler span and `http.route`
remain. A 5xx turns the server span to `ERROR` by itself. The exception filter
(`toProblem()`) runs while Express's request-handler span, the server span's child, is active. It
records the exception on that span as an event, sets its status to `ERROR`, and logs it with the
same trace_id.
For 4xx the server span stays `Unset`, which is why the trace demo uses a 5xx.

Spans are exported in batches (`BatchSpanProcessor`). Because of that, `demo:trace` polls Jaeger
every 500 ms until the span count stops growing, with a deadline of 20 s. On shutdown Nest calls
`TelemetryShutdown` (`src/app.module.ts`), which runs `sdk.shutdown()` and flushes what is still
in memory.

A failing checkout, as `demo:trace` prints it (`span ← parent`; reordered parent-first, comments mine):

```
POST /orders, traceparent 00-796559d5755688937034c214492a3ae8-f81f876650a57690-01 → 500
  501ff8281e0e17a8 ← f81f876650a57690  POST /orders  [ERROR]        ← parent = the header's parent-id
  8c99698572ddefc0 ← 501ff8281e0e17a8  request handler - /orders  [ERROR]  ← exception event + status from toProblem()
  11e0e3df2be38291 ← 8c99698572ddefc0  pg-pool.connect                (the guard's denylist lookup)
  5ff0f8cb970a35c6 ← 8c99698572ddefc0  pg.query:SELECT marketplace
  1070cbb1a4f70047 ← 8c99698572ddefc0  orders.place  [ERROR]          ← the manual span
  574909c7ee78263b ← 1070cbb1a4f70047  pg-pool.connect
  86966e7f65dafe1a ← 1070cbb1a4f70047  pg.query:SELECT marketplace  [ERROR]   ← division by zero
  log orders.controller: trace_id=796559d5755688937034c214492a3ae8 span_id=8c99698572ddefc0 "checkout requested"
  log orders.service: trace_id=796559d5755688937034c214492a3ae8 span_id=1070cbb1a4f70047 "pricing order lines"
  log http.problem: trace_id=796559d5755688937034c214492a3ae8 span_id=8c99698572ddefc0 "division by zero"
  log http: trace_id=796559d5755688937034c214492a3ae8 span_id=501ff8281e0e17a8 "request completed"
```

### The demo faults

The 500 and the slow requests are real database round trips. They are not a thrown string or a
`setTimeout`. With `FAULT_INJECTION=1`, which only the demos set, and only for their own child,
`X-Fault: slow` makes `ProductsRepository.findById` run `SELECT pg_sleep(1.2)`, and `X-Fault: error`
makes it run `SELECT 1 / 0`. Postgres answers that with `division by zero`, which surfaces as a 500
through the normal error path. The repository reads the fault from the request context, not from an
argument, so the deepest layer reacting to it is one more proof that the context got that far.

### The three runs

The numbers below are mine, and identical over three runs in a row. Only `slowest-ms` moves, by a
few ms.

```
$ npm run demo:logs
single: 201, 6 lines, layers: orders.controller → orders.service → products.repo → http
burst: 10 requests (201 ×10), 60 lines in 10 trace groups of sizes 6,6,6,6,6,6,6,6,6,6
secret: login 401, request lines 1, lines with a marker 0
non-json-lines=0
lines-total=102
layers=4
distinct-trace-ids=1
trace-id-matches-header=1
burst=10
burst-trace-ids=10
burst-uneven=0
burst-mixed-keys=0
secret-req-logged=1
secret-in-logs=0
```

Each request's lines are found by its `Idempotency-Key` (from the context), not by the trace_id
being tested. The burst lines are grouped by `trace_id`. A group's size must equal the others',
and no line may carry another request's key (`burst-mixed-keys`). The secret request sends
`Authorization: Bearer bearer-marker-<random>` and the password `password-marker-<random>`. Its
request line is in the log with `[Redacted]` in both places, and neither marker appears in any of
the 102 lines.

```
$ npm run demo:metrics
prometheus (http://127.0.0.1:22901): scraped this process before the load
sent 60: 201 ×52, 500 ×8
slowest reply 1224 ms; top finite bucket le="10"
100 ids → 100 × 404; 2 GET routes in the counter
prometheus: scraped this run (101 GET /orders/:orderId)
sent-ok=52
sent-fail=8
counter-delta=60
errors-delta=8
top-bucket-seconds=10
slowest-ms=1224
above-top-bucket=0
ids=100
series-before=5
series-after=5
```

`counter-delta` and `errors-delta` are differences between two scrapes of `/metrics` for
`POST /orders`. The two `prometheus` lines are informational, and the demo waits for them for at
most 10 s and 15 s. Every demo starts a new process, and Prometheus computes `rate()` from its own
scrapes, so a load sent before its first scrape of that process would be hidden in the series'
starting value and never reach the dashboard. `above-top-bucket` is `_count` minus `_bucket{le="10"}` for the same route. The
five series are `POST /auth/login 200`, `POST /orders 201`, `POST /orders 500`, `GET /health 200`
and `GET /orders/:orderId 404`. The route is warmed with one `GET /orders/o_warmup` before
`series-before` is counted.

```
$ npm run demo:trace
status=500
spans=7
orphan-spans=0
trace-matches-header=1
trace-matches-log=1
log-lines=4
span-status-error=1
```

`trace-matches-header` is 1 when Jaeger returns the trace under the header's trace-id **and** the
server span's parent is the header's parent-id. `trace-matches-log` is 1 when the request's log
lines carry exactly one trace_id, that trace_id is Jaeger's, and **every `span_id` they name is a
span of that trace**. `orphan-spans` counts spans whose parent is neither in the trace nor the
caller's span from the header.

**Proof that the demos catch what they claim to catch.** I broke `dist/` by hand, ran the demo,
then rebuilt:

| Breakage | Result |
|---|---|
| the trace_id taken from a module variable set by the last request to arrive | `burst-trace-ids=3 burst-uneven=2 burst-mixed-keys=54`, exit 1 |
| `route` = `req.path` instead of the template | `series-before=5 series-after=105`, exit 1 |
| no exporter and no span processor (the NodeSDK case above) | `trace_id=000…0` on every line |
| the `'close'` listener without `AsyncResource.bind`, client aborts a slow checkout | the `499` line has `trace_id`, no `userId` |

### SLO, in one paragraph (bonus)

SLI: the share of `POST /orders` requests that are not 5xx and finish under 500 ms, measured from
`http_requests_total` and `http_request_duration_seconds_bucket{le="0.5"}` (0.5 is a bucket bound
on purpose, so the SLI is exact and not interpolated). SLO: 99.5 % over a rolling 30 days. Error
budget: 0.005 × 30 days × 24 h × 60 min = **216 minutes a month** of complete failure, or the same
budget spent as 0.5 % of requests. Once it is used up, releases wait and reliability work goes
first.

### Not done

The rest of the bonus is not done: GlitchTip/Sentry, a second process with an outgoing call, and
a live alert. Tail sampling, Loki and a profiler are out of scope. The OTel Collector is not part
of the stand: the API exports straight to Jaeger's OTLP receiver. With a collector in between,
only `OTEL_EXPORTER_OTLP_ENDPOINT` would change.

# AWS: a paid stand, and proof that it is gone (AWS: платний стенд і доказ знесення)

The question for this homework is not "can it be brought up" but "can someone else's paid
hardware be created and handed back so that nothing of it is left, and can that be shown in
numbers". The proof is a teardown run in GitHub Actions whose log ends in six zeros.

## AWS

смуга: запасна (LocalStack)
teardown-run: https://github.com/martsyniuk-denys/r_d/actions/runs/45222852822
region: eu-central-1 (stack config); every emptiness check also covers us-east-1

**Paths for the criteria.** The programs are `infra/base` and `infra/demo` (A1). The
`package.json` with the npm scripts is the **root** `package.json`. `git ls-files` sorts
`infra/base/package.json` first, so B3 needs `PKG=package.json`. `infra/package.json` is the
Kubernetes program from homework 28.

**Why the fallback lane.** I already had an AWS account in the past, so AWS will not give me
the Free plan or its credits ("You would be ineligible for free plan or Free Tier credits if you
have an existing AWS account or have had one in the past"). Every hour would be billed in real
money from the first minute. I declared the fallback lane before the first `pulumi up` and did
not change it after.

| Piece | Where |
|---|---|
| base stack: budget, VPC, 2 + 2 subnets, IGW, route tables, 3 SGs, OIDC provider, teardown role | `infra/base/index.ts`, `infra/base/Pulumi.base.yaml` |
| demo stack: RDS Multi-AZ, ALB + target group + Lambda target, NAT behind `hw31:withNat` | `infra/demo/index.ts`, `infra/demo/Pulumi.demo.yaml` |
| running a stack (backend, passphrase, region from the stack config) | `scripts/aws.sh` |
| the six emptiness checks, both regions | `scripts/aws-checks.sh` |
| `evidence/base.txt`, `base-state.json`, `iam.json`, `iam.txt` | `scripts/aws-evidence.sh` |
| `evidence/localstack-iam.txt` | `scripts/localstack-iam.sh` |
| `demo:failover`, `demo:alb`, `demo:nat` (main lane only, see below) | `demo/failover.sh`, `demo/alb.sh`, `demo/nat.sh`, `scripts/lib/aws.sh` |
| nightly + on-demand teardown | `.github/workflows/teardown.yml` |
| LocalStack `4.14.0`, port 23166 | `localstack/compose.yml` |

### LocalStack, and the price of the pin

`localstack/localstack:4.14.0` is pinned hard, on `127.0.0.1:23166`. Later tags do not start
without `LOCALSTACK_AUTH_TOKEN`, and that token is tied to a personal account. It would end up in
a public repository. The price of the pin, in LocalStack's own words: "pinning to a prior version
will opt you out of any future updates or security patches". This is an emulator on localhost
that is pulled once and removed after the homework, not a service that should get patches.

What the community edition actually serves (probed before writing the programs):

| API | 4.14.0 community | Effect here |
|---|---|---|
| EC2 (VPC, subnets, IGW, route tables, SGs, NAT, EIP), IAM, STS, Lambda, tagging | emulated | the base stack is real: `vpc-…`, `subnet-…`, `sg-…` |
| Budgets | **501** | the budget is skipped when `AWS_ENDPOINT_URL` is set, and only then |
| RDS, ELBv2 | **501** | the demo stack stops at `pulumi up` (`evidence/501.txt`) |

One difference from the task's text: 4.14.0 words its 501 as `The API for service rds is either
not included in your current license plan or has not yet been emulated by LocalStack`, not
"not included within your LocalStack license". `evidence/501.txt` is the untouched output, so
`grep -c 'not included within your LocalStack license' evidence/501.txt` prints 0, and
`grep -c 'not included in your current license plan' evidence/501.txt` prints 9. It is the same
error. I did not edit the evidence to match the phrase.

### Two stacks

`base` costs exactly $0 and may stay up for a week: the budget, the VPC `10.31.0.0/16` (overlaps
neither Docker's bridges nor kind), public `10.31.0.0/24` and `10.31.1.0/24`, private
`10.31.10.0/24` and `10.31.11.0/24` in `eu-central-1a` and `eu-central-1b`, an IGW, two route
tables, three security groups and the CI role. Nothing in it is billed by the hour, and
`evidence/base-state.json` has no `aws:rds/`, `aws:lb/`, NAT, EC2 instance or EIP.

`demo` holds everything billed by the hour. It reads the network through a `StackReference` and
lives for a session: RDS, ALB, target group, the Lambda target and, behind `hw31:withNat=true`,
one NAT with its EIP.

The **budget is the first resource** in `infra/base/index.ts`. Every other resource depends on it,
so a parallel `up` also creates it first. It has `COST`, `MONTHLY`, `limitAmount: '5'` for the
whole account (no tag filter, because cost-allocation tags lag), and one `ACTUAL` notification
`GREATER_THAN` 20 `PERCENTAGE`. The address comes from `ALERT_EMAIL` in the store, never from git.
It is a letter, not a brake: actual spend is refreshed every 8–12 hours, which at this stack's
rate is up to $0.08191 × 12 = $0.98 before the letter can leave.

**Private means a missing line.** The private subnets have their own route table with **no**
`0.0.0.0/0`. It points neither to the IGW nor to a NAT. Only the database lives there, and it
never calls out. `evidence/base.txt` counts this from the API (`private-default-route=0`), not
from the names. A subnet counts as public only if its table routes `0.0.0.0/0` to an `igw-`.

Security groups, one reason per open port (the comments in the code say the same):

| Group | Inbound | Why |
|---|---|---|
| `alb` | 80/tcp from `0.0.0.0/0` | internet-facing HTTP. No domain, so no certificate, so no 443 |
| `app` | 3000/tcp from the `alb` group | a target is reachable through the balancer or not at all |
| `db` | 5432/tcp from the `app` group | Postgres answers the application and nothing else; no CIDR |

Egress is narrowed too: the ALB reaches only the VPC, the app only 5432, and the database has
none (stateful SGs let replies out).

Tags come from one block per stack, `aws:defaultTags` in `Pulumi.<stack>.yaml` (`Project:
nodejs-pro-hw31`, `Stack: base|demo`, `ManagedBy: pulumi`). The same file pins `aws:region`.
Nothing reads `~/.aws/config` or `AWS_REGION`, and nothing runs `aws configure` or `pulumi login`.
Endpoint, backend and keys are variables of the process.

### Rate per hour

Rates read on 2026-11-16 from the public AWS bulk price list for `eu-central-1`
(`https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<service>/current/eu-central-1/index.json`;
no account needed). The column "published" is the list's own `publicationDate`. A month is 730
hours. The UAH column uses the NBU rate of 45.4274 UAH/$ on 16.11.2026.

| Line | Price list (published) | Rate | × 730 h |
|---|---|---|---|
| ALB | AWSELB (2026-11-11) | $0.027 per ALB-hour | $19.71 |
| RDS db.t4g.micro PostgreSQL, Multi-AZ instance | AmazonRDS (2026-11-13) | $0.037/h (Single-AZ: $0.019) | $27.01 |
| gp3 20 GiB, Multi-AZ | AmazonRDS (2026-11-13) | $0.274 per GiB-month × 20 | $5.48 |
| Public IPv4 × 2 (under the ALB) | AmazonVPC (2026-11-05) | $0.005/h each, in use or idle | $7.30 |
| LCU | AWSELB (2026-11-11): $0.008 per LCU-hour | ⚠️ an assumption about training load, not a list rate | $0.29 |
| **Total** | | **$0.08191/h** | **$59.79** (≈ 2 716 UAH) |
| NAT Gateway (only for `demo:nat`) | AmazonEC2 (2026-11-14) | $0.052/h + $0.052/GiB processed | one exercise: $0.052 + $0.005 = $0.057 |

Every other number divides or multiplies this one: 4 hours = $0.33 (≈ 15 UAH), a day = $1.97
(≈ 89 UAH), a month = $59.79. Every rate equals the task's 24.08.2026 snapshot, so none of the
derived numbers moved. The lists did get republished since then. The Multi-AZ instance is
"almost double", not double: $0.019 → $0.037. Storage doubles exactly: $0.137 → $0.274. A
Multi-AZ *DB cluster* on the cheapest class in the same list (`db.m6gd.large`, readable standbys)
is $0.622/h. On this lane all of it is $0. The table is the bill the main lane would have run up.

### The CI role (OIDC) and its policy

`hw31-teardown` trusts only `token.actions.githubusercontent.com`, with `StringEquals` on
`aud = sts.amazonaws.com` and `StringLike` on
`sub = repo:martsyniuk-denys@16865806/r_d@1325481547:*` (any ref of this repository, no other
repository). The ids in `sub` are not decoration. The teardown run's log printed the claim, and
GitHub issues this repository's tokens with `repo:<owner>@<owner-id>/<repo>@<repo-id>:…`. My
first trust said `repo:martsyniuk-denys/r_d:*`, which would never have matched on real AWS. On
LocalStack it "worked", because nothing is checked there. Both documents, decoded, are in
`evidence/iam.json`. The
permission policy names every action, and no `Action` is `"*"`:

| Permission | Why teardown needs it |
|---|---|
| `tag:GetResources` | the `tagged-resources-left` check |
| `rds:DescribeDBInstances` | `rds-left`, and the provider waits on it while deleting |
| `rds:DescribeDBSubnetGroups`, `rds:ListTagsForResource` | the provider reads the subnet group and tags before deleting |
| `elasticloadbalancing:DescribeLoadBalancers` | `alb-left`, and the provider's read before delete |
| `elasticloadbalancing:DescribeLoadBalancerAttributes`, `DescribeListeners`, `DescribeTargetGroups`, `DescribeTargetGroupAttributes`, `DescribeTargetHealth`, `DescribeTags` | the provider refreshes each ALB-side resource before deleting it |
| `ec2:DescribeNatGateways` | `nat-left`, and waiting for a NAT to reach `deleted` |
| `ec2:DescribeAddresses` | `eip-left` |
| `lambda:GetFunction`, `lambda:GetPolicy`, `lambda:ListVersionsByFunction` | reading the Lambda target and its ALB permission before deleting them |
| `iam:GetRole`, `iam:ListAttachedRolePolicies`, `iam:ListRolePolicies`, `iam:ListInstanceProfilesForRole` | a role cannot be deleted before what is attached to it is listed and detached |
| `rds:DeleteDBInstance`, `rds:DeleteDBSubnetGroup` | delete the database, **only if tagged `Project=nodejs-pro-hw31`** |
| `elasticloadbalancing:DeleteLoadBalancer`, `DeleteListener`, `DeleteTargetGroup`, `DeregisterTargets` | delete the ALB side, same tag condition |
| `ec2:DeleteNatGateway`, `ec2:ReleaseAddress`, `ec2:DisassociateAddress` | delete the NAT and give its address back (the `eip-left` trap), same tag condition |
| `lambda:DeleteFunction`, `lambda:RemovePermission` | delete the target, same tag condition |
| `iam:DetachRolePolicy`, `iam:DeleteRole` | only on `role/hw31-demo-*`, the Lambda's role |

There is no `Create*` and no `Modify*`. Teardown can only take things away. A role that can create
a database can also run up the bill.

`aws iam simulate-principal-policy` on the role (`npm run evidence:iam` → `evidence/iam.txt`):

```
engine=localstack
sim-allowed-action=ec2:DescribeNatGateways
sim-allowed=allowed
sim-denied-action=rds:CreateDBInstance
sim-denied=explicitDeny
```

**This is not the negative test the task asks for, and I am not counting it as one.** The engine
that decides was LocalStack, not AWS. The answer itself shows it: no statement mentions
`rds:CreateDBInstance`, so AWS would answer `implicitDeny`. LocalStack's simulator invented an
explicit deny. Its simulator and its enforcement are two separate pieces of code, and the
enforcement does not run at all (next section). The negative test that counts has to run on AWS:
the same `npm run evidence:iam` without `AWS_ENDPOINT_URL`, expecting `allowed` and
`implicitDeny`.

### LocalStack does not apply IAM. At all

**LocalStack does not apply this policy. I did not test it locally, because it cannot be tested
locally.** (LocalStack цю політику не застосовує. Я не перевіряв її локально, бо перевірити
локально неможливо.) I have not tested that a foreign `sub` is rejected, and nothing in this
repository claims it.

What it does instead, measured on my machine by `npm run evidence:localstack-iam`. The file is
`evidence/localstack-iam.txt`, a full transcript; each code is the HTTP status of a SigV4-signed
request made with `curl --aws-sigv4`, and `ENFORCE_IAM=1` is set on the container:

```
user hw31-probe-nobody: 0 inline, 0 attached policies
  no policy:  CreateBucket hw31-probe-a-… → 200
  deny-all:   CreateBucket hw31-probe-b-… → 200, PutObject → 200
  fake key:   GetObject → 200 (body: only the owner should read this)
  forged JWT: AssumeRoleWithWebIdentity → 200, AccessKeyId LSIA…
localstack=4.14.0
enforce-iam=1
no-policy=200
deny-all=200
fake-key=200
oidc-forged-jwt=200
enforce-iam-log-lines=0
```

The forged JWT says `sub=repo:EVIL/attacker`, `aud=WRONG`, `alg=none`, and has no signature. The
role trusts `repo:acme/shop:*`. LocalStack still handed out working credentials. The teardown job
relies on the same leniency: it assumes `hw31-teardown` before `base` has even created it.

The container log counts lines about a denial or enforcement (`enforce-iam-log-lines=0`), not
every line that mentions IAM. 10 of 14 lines in the window were IAM/STS requests. Not one was a
refusal.

A 200 here proves no policy right, only that nobody read it. LocalStack errs toward *allow*: it
allows more than production does, so a policy mistake would surface at 3 a.m. in production, not
on this machine. The other emulator in this course that errs the same way is LocalStack again,
in the files homework (26). That is why `docker-compose.yml` runs RustFS there: an anonymous GET
against LocalStack is not a trustworthy 403 (see [Files](#files-файли)).

### No keys: OIDC in CI, the store locally

- **CI** has no key at all, neither in the repository nor in GitHub Secrets. The job has
  `id-token: write`. It writes GitHub's OIDC JWT (audience `sts.amazonaws.com`) to a file, and the
  AWS CLI and the Pulumi provider trade it for short-lived credentials through
  `AWS_WEB_IDENTITY_TOKEN_FILE` + `AWS_ROLE_ARN` (`sts:AssumeRoleWithWebIdentity`). The flow is
  the same against AWS. Here the STS is LocalStack's. That takes `AWS_ENDPOINT_URL_STS` as well:
  the Pulumi provider resolves its credentials before it reads `AWS_ENDPOINT_URL`. In the first
  run it sent the GitHub token to real AWS STS (`InvalidIdentityToken`; no account trusts it).
  That run also showed why every step runs under `shell: bash` (pipefail): `pulumi up | tail`
  hid the failure, and the job printed six zeros over a stand that had never been created. Those
  zeros were true and worthless, so I do not submit that run. The stand step now fails unless
  `base` has resources before the destroy. The job prints the token's `iss`, `aud` and
  `sub`, never the token.
- **Locally** the keys come from the store of homework 11 through the same wrapper,
  `scripts/with-secrets.sh`: `AWS_ENDPOINT_URL` and `AWS_ACCESS_KEY_ID` in `.env`, and the secret
  in `secrets/aws_secret_access_key` (`AWS_SECRET_ACCESS_KEY_FILE`). On this lane the pair is
  LocalStack's well-known `test`/`test`, but it travels the way a real one would. The same goes
  for `DB_PASSWORD` (the RDS master password, a Pulumi secret in the state) and
  `PULUMI_CONFIG_PASSPHRASE`. All seven fixed npm scripts go through the wrapper.

### State backend: what changed since homework 28

Locally it is the same `file://<repo>/.pulumi` as for the kind cluster in homework 28. The task
allows a file backend on this lane, because there is nothing to bill. The difference is CI. In
homework 28 nobody but my laptop ever had to read the state. Here the teardown job must reach the
state of the stand it destroys, and a runner cannot see my laptop. On this lane the job brings up
its own LocalStack and its own stand, so the state is born and destroyed in the runner's workspace
(`file://$GITHUB_WORKSPACE/.pulumi`, a passphrase generated per job and masked). On the main lane
that is not enough, because the stand lives in AWS longer than any job. There it would be Pulumi
Cloud (individual, $0) or an `s3://` backend in the same account, and `PULUMI_BACKEND_URL` is the
only line that changes in `scripts/aws.sh`.

`encryptionsalt:` is stripped from `Pulumi.<stack>.yaml` before committing. It derives from my
passphrase, and CI's passphrase is a different one.

### Teardown as code

`.github/workflows/teardown.yml` runs on `schedule: '0 2 * * *'` and on `workflow_dispatch`. The
run linked at the top is a dispatch run, because a schedule may be late or dropped. Its order:

1. a LocalStack 4.14.0 service container, and OIDC → web identity;
2. **stand**: `pulumi up` base, then demo. Demo creates what the community edition serves (the
   Lambda target and its IAM role), and its RDS and ELBv2 calls fail with 501 in the log.
   LocalStack gets the runner's Docker socket. Without it the Lambda ends up `Failed: Docker not
   available`, `DeleteFunction` on such a function is an `InternalError`, and `pulumi destroy`
   retried it until the job timed out (an earlier run, cancelled after 19 minutes). The destroy
   step has its own 8-minute limit now. Without this step
   there is nothing to destroy, and six zeros over an empty emulator prove nothing.
   `state-before[...]` records how much there was;
3. `pulumi destroy --yes`: demo, then base;
4. `pulumi stack export` of both stacks, uploaded as an artifact. No `--remove`, because after it
   there is nothing to export;
5. the six checks of `scripts/aws-checks.sh`, in eu-central-1 **and** us-east-1. Each contract key
   is the sum of both regions and is printed once. The job fails if any is non-zero.

Two honest notes about the checks. **`rds-left` and `alb-left` on this lane**: LocalStack answers
every RDS and ELBv2 call with 501, so no instance can exist there. The script counts that as 0
and says so in a line of its own (`rds@eu-central-1: 501, API not emulated …`). Any other error
fails the job, because an unreadable check is not a zero. **`state-resources-left`** counts `aws:*`
resources in the state of both stacks. `tagged-resources-left` asks the tagging API, which is the
second source of truth: a resource created by hand outside Pulumi shows up only there. Its query
is the contract's, verbatim: `Key=Project,Values=nodejs-pro-hw31 Key=Stack,Values=demo`, ARNs
with `:natgateway/` excluded. Without `Stack=demo` a live `base` (which on the main lane stays
after the session) would count; without the exclusion a NAT already `deleted`, which the tagging
API keeps listing for about an hour, would. `nat-left` counts NATs in `pending` **and**
`available`: a NAT still being created is billed already. Every change to a filter here changes
what a zero means, so none of them is mine to choose.

The emptiness checks run locally as well: `npm run destroy:base` writes the same six keys into
`evidence/demos.txt`. That file is written by my machine, so it is a floor, not a proof. The
proof is the CI run.

On the main lane, two things in that workflow would change. `AWS_ROLE_ARN` would be the real role
from `pulumi stack output teardownRoleArn`, with no `AWS_ENDPOINT_URL`. The stand step would go,
because the stand already exists in AWS and the job only destroys `demo`. `hw31-teardown`'s
policy is written for exactly that: it deletes, it never creates. `base` is removed by hand after
grading (`npm run destroy:base`). A role allowed to delete things should not outlive the course.

### RDS Multi-AZ (written, 501 on this lane)

`infra/demo/index.ts` declares a **Multi-AZ instance deployment**, not a Multi-AZ DB cluster:
`multiAz: true`, `db.t4g.micro`, PostgreSQL 16, `gp3` 20 GiB, `storageEncrypted: true`,
`backupRetentionPeriod: 1`, in the private subnets, `publiclyAccessible: false`. Performance
Insights and Enhanced Monitoring are off: neither is graded, and both are billed.
`pulumi.runtime.registerResourceTransform` is registered **before** the first resource and sets
`deletionProtection: false` and `skipFinalSnapshot: true` on every `aws:rds/instance:Instance`.
`evidence/preview-demo.txt` (`pulumi preview`, which only type-checks and diffs) shows both values
on the instance. `evidence/501.txt` is the `pulumi up` that follows.

The target behind the ALB is a Lambda rather than an EC2 instance. That adds no hourly line and
no third public IPv4. The Lambda target group has its health check switched on, because it is
off by default for Lambda, and the state would never become `healthy`.

`demo:failover`, `demo:alb` and `demo:nat` are written for the main lane. They read the stack's
outputs, poll rather than sleep, and write their keys into `evidence/demos.txt`, replacing older
values. On this lane they stop at once with a pointer here: RDS and ELBv2 are 501. A NAT
"billed hour" measured on an emulator that does not bill would be a number about nothing. **They
have not been run against AWS**, so `az-*`, `failover-seconds`, `http-code`, `target-state` and
`nat-*` are absent from `evidence/demos.txt`, by design rather than by accident. Criterion D is
not graded on this lane.

### RDS Multi-AZ against my stack from homework 15

My homework-15 stack was a single Postgres, PgBouncer in front of it, `scripts/backup.sh` (a
nightly `pg_dump`, RPO 24 h) and a weekly restore drill. **It had no replica.** So Multi-AZ adds
something I never had, rather than replacing something I did.

What RDS takes over:

- the synchronous standby in another AZ, and the failover. The endpoint's DNS moves in about
  60–120 s, without me;
- the backups as an RPO mechanism: daily snapshots plus transaction logs give point-in-time
  restore within the retention. That changes the RPO from my 24 hours to minutes, but only within
  `backupRetentionPeriod: 1`, one day;
- encryption at rest, minor-version patching, and the host and its disk.

What stays mine:

- **PgBouncer**. RDS does not pool. RDS Proxy is a separate service and a separate line on the
  bill, and the transaction-mode trade-offs from homework 15 do not go away.
- **Reads**. A Multi-AZ *instance* standby serves no reads at all. Read scaling would need a read
  replica: another instance and another hourly line.
- **The restore drill**. AWS restores a snapshot into a new instance. Proving that the restore
  holds my data, and measuring the RTO, is still my script.
- **Long-term and portable copies**. One day of PITR is not an archive. A logical dump that opens
  outside AWS is still `backup.sh`.
- **The application side of a failover**: connections drop for the 60–120 s, and the retry
  wrapper from homework 14 is what turns that into latency instead of 500s.
- migrations, the master password in the store, sizing, and the retention setting itself.

### KMS

`storageEncrypted: true` uses the AWS-managed key `aws/rds`. AWS does not bill that key per month,
and it is not mine to delete. KMS is **not** a replacement for the store from homework 11; it is
the layer under it. The store decides which process gets which secret. KMS holds a
key-encryption key that never leaves AWS and answers one question: "may this principal decrypt
this?". The answer is IAM, and it is audited. This project's equivalents of an `ENCRYPTION_KEY`
(the JWT signing key, the refresh-token pepper, the Pulumi passphrase) would be stored encrypted
under a data key that KMS wraps, and decrypted with `kms:Decrypt` at start-up. The store would
still deliver them. I did **not** create a customer-managed key: it is a monthly line of its own,
and `destroy` only *schedules* its deletion (7–30 days), so it outlives the stack.

# CI/CD: a pipeline in which every step can say no (CI/CD: конвеєр, у якому кожен крок може сказати «ні»)

On #28 I ran everything myself, from my own machine: the build, the scan, `pulumi up`,
`demo:rollout`. Now the pipeline runs the same scripts on every PR, and a PR can be merged only if
each of them says yes. None of the pieces is new; what changed is who runs them. A step that
cannot fail is a report, not a gate, so each gate below is checked both ways:
`npm run demo:gates` and `npm run demo:oidc` show it failing on a broken input and passing on a
correct one.

## CI/CD

pr-run: https://github.com/martsyniuk-denys/r_d/pull/23 — the graded run is the latest green `pr` run on the PR head (first green: https://github.com/martsyniuk-denys/r_d/actions/runs/43934560195 — 243 468 requests, failed=0, rollout 24 s, built = deployed = registry digest)
cost-gate-bypass-label: cost-approved
contract-gate-bypass-label: breaking-approved

**Paths for the criteria.** The workflows are in `.github/workflows/`. The trust condition is
`oidc/policy.json`, and the gate that applies it is `scripts/oidc-gate.mjs`. The cost mapping is
`src/mapping.ts` (the CLI around it is `src/cost-gate.ts`). The Pulumi program is `infra/`, the
same program as #28; the only change is that `APP_IMAGE` can override the image. The npm scripts
are in the root `package.json`.

### Jobs and their dependencies

```
pr.yml (pull_request, workflow_dispatch)        deploy.yml (push to main, workflow_dispatch)
  │                                                │  same jobs, except build → promote:
  │                                                │  the digest of the PR's green run
  ├─ gates ── gates.yml ───────────────┐
  │    ├─ workflows   actionlint                   │
  │    ├─ types       tsc --noEmit + eslint        │
  │    ├─ contract    oasdiff breaking, base → PR  │
  │    ├─ arch        dependency-cruiser           │
  │    └─ pact        contract.yml (HW #16)        │
  ├─ build ── build.yml ───────────────┤  the only docker/build-push-action in the repo
  │    build → push to GHCR → digest in outputs → pull back by digest
  │    → demo:image → npm run scan (step 4 of the ladder)
  ├─ deploy ─ deploy-kind.yml  needs: [gates, build], environment: kind
  │    OIDC gate → kind + crictl pull <repo>@<digest> → pulumi preview --json
  │    (+ the base branch's) → gate:cost → pulumi up → manifest check
  │    → demo:rollout (failed must be 0) → manifest check again
  └─ evidence  needs: all three, if: always() → artifact pipeline-evidence
```

| Workflow | Triggers | What it is |
| --- | --- | --- |
| `pr.yml` | `pull_request`, `workflow_dispatch` | gates, a single build, preview, cost gate, deploy to kind, rollout, evidence |
| `deploy.yml` | `push` to `main`, `workflow_dispatch` | the same chain for the main branch, without a build: it deploys the digest the PR's green run verified; `pulumi up` runs only after every gate is green |
| `gates.yml`, `build.yml`, `deploy-kind.yml` | `workflow_call` | the reusable parts the two workflows share |
| `contract.yml` | `workflow_call`, `workflow_dispatch` | Pact (#16), called by `gates.yml` |
| `teardown.yml` | `schedule` + `workflow_dispatch` | #31's teardown; manual dispatch is there because a scheduled run can come late |

The shared setup steps (Node 22, the npm cache keyed on both lock files, `npm ci`) live in the
composite action `.github/actions/node`. The assembly of the evidence artifact lives in
`.github/actions/evidence`.

Every `uses:` that points outside the repository is pinned to a commit SHA, with the tag in a
comment next to it (`actions/checkout@3d3c42e…  # v7.0.1`). A tag can move: `@v7` today and `@v7`
next month may be different code, and that code runs with this job's permissions. The whole set
passes `actionlint` with no findings, and the `workflows` gate runs it on every PR.

**Build once, promote by digest.** The image is built in exactly one place. `build.yml` pushes
`ghcr.io/martsyniuk-denys/r_d:<github.sha>` and returns `steps.build.outputs.digest` as a job
output. `deploy-kind.yml` gets that digest as an input and sets
`APP_IMAGE=<repo>@sha256:…`, which is what Pulumi writes into the pod template. The tag is there
for people; nothing is deployed by tag. The image is pulled into the kind node with
`crictl pull` by digest, so the node holds the registry's digest, which is the one the pod spec
names. `kind load` of an image from the host would repack it under a different digest. After
`pulumi up`, `scripts/ci/manifest.sh` reads the Deployment back from the cluster and fails if
its digest differs from the built digest. The GHCR package is public, so the grader can compare
the digest with the registry.

**main promotes, it does not rebuild.** `deploy.yml` has no `build` job. Its `promote` job
(`scripts/ci/promote.sh`) finds the merged PR of the pushed commit, then the green `pr` runs on
that PR's head, and takes the first one whose tested commit (the merge commit GitHub built for
the PR, the tag of its `image-ref`) has the same git tree as the pushed commit. From that run's
`pipeline-evidence` it takes `built-digest`, and only if `deployed-digest` equals it. A run that
tested the PR against an older base checked different code, so it does not count; then `promote`
fails and main does not deploy until the PR is updated and green again. The main run's
`evidence.txt` has `build-invocations=0` and `promote-pr`, `promote-from-run`,
`promote-tested-sha`, `promote-digest`.

### Where it deploys, and what the environments are called

There is one environment, **`kind`**. It is a GitHub Environment, and it is the only place that
holds `STORE_KEY`. The stand is a one-node kind cluster created inside the runner. The Pulumi
state uses a file backend in the workspace (`PULUMI_BACKEND_URL` defaults to `file://<repo>/.pulumi`,
the same as #28), so the pipeline never logs in to a Pulumi account. The cluster and its state
are gone when the job ends. A PR run and a `main` run deploy to the same environment, and in
both cases the OIDC `sub` is `…:environment:kind`.

### OIDC instead of a long-lived key, with the signature verified

The deploy job is the only job that holds `permissions: id-token: write`. The grant is on the job
(`deploy-kind.yml`, and on the calling job in `pr.yml` and `deploy.yml`), never on a file. A
file-level grant would let every job ask for a token, including the jobs that run the PR's code.
The first step of the job asks GitHub for an ID token with `aud=marketplace-kind-deploy` and
writes it to a 0600 file. It then runs `scripts/oidc-gate.mjs`, which:

1. fetches `<issuer>/.well-known/openid-configuration` and checks that its `issuer` is the one
   expected, then follows `jwks_uri`;
2. verifies the RS256 signature with the key from that set whose `kid` matches. It accepts only
   RS256, because `none` and `HS*` (an HMAC keyed with a public key) are the classic ways to make
   a signature "verify" without the issuer's private key;
3. checks `iss`, `aud`, `exp`/`nbf` and `sub` against `oidc/policy.json`;
4. prints `iss`, `aud`, `sub`, `sig-verified` and `policy-allow`. It never prints the token.

The issuer, the audience, the JWKS address and the policy file are all parameters, so the gate
cannot tell CI from `demo:oidc`. The `sub` condition is an exact match, with no patterns:

```
repo:martsyniuk-denys@16865806/r_d@1325481547:environment:kind
```

That line is the only thing that tells this repository from any other. Without it, `iss`, `aud`
and the signature all stay green for any GitHub repository that asks for this audience. This
repository's `sub` carries GitHub's immutable ids (`owner@owner-id/repo@repo-id`), the same as on
#31. A condition written as `repo:martsyniuk-denys/r_d:…` would never match it. Because the job
has `environment: kind`, its `sub` ends in `environment:kind` and not in a `ref:`. A condition on
the branch would never match a job that has an environment.

Without a cloud, the gate itself decides whether the deploy goes ahead. If the gate says no, the
step fails and nothing after it runs. On real AWS the same token would go to
`sts:AssumeRoleWithWebIdentity` through the #31 role, whose trust policy checks the same `aud`
and `sub`. LocalStack accepts any token, including one without a signature
(`evidence/localstack-iam.txt`). That is why the check is code of my own, tested on real
signatures that I make myself.

### Two sets of secrets that never mix

**The pipeline's secrets**, meaning registry and cloud access, are not stored anywhere. The
registry is reached with the job's `GITHUB_TOKEN` (`packages: write` for the build,
`packages: read` for the pull into kind). Identity comes from the OIDC token, which lives for
minutes and exists only for the deploy job. There is no `AWS_*`, registry password or service
account key in GitHub Secrets. The build-stage npm token is a random value generated in the job,
because there is no private npm registry (#28).

| `${{ secrets.X }}` | Where it is set | Why |
| --- | --- | --- |
| `STORE_KEY` | secret of the `kind` environment | the key to the store (`store/ci.enc`). It opens the store, not a cloud or a registry. Only jobs in the `kind` environment can read it |
| `PACT_BROKER_URL` | repository secret, optional; **not set** | a hosted Pact broker (#16). When it is empty, the broker from compose runs on the runner |
| `PACT_BROKER_TOKEN` | repository secret, optional; **not set** | the token for that broker |
| `GITHUB_TOKEN` | issued by GitHub for each job | GHCR: push in `build`, pull into kind in `deploy` |

**The app's secrets** live in the store from #11 and appear when the app is deployed, not when it
is built. On a laptop the store is `.env` plus `secrets/`. A runner has neither, so for CI the
store is `store/ci.enc`: `NAME=value` lines encrypted with AES-256-CBC and PBKDF2 (200,000
iterations), committed only as ciphertext. `scripts/with-secrets.sh ci …` decrypts it into its
own process, never to disk, exports the values and unsets `STORE_KEY` before it runs the command.
The app and Pulumi never see the key. The values were generated for CI (`scripts/store-ci.sh init`)
and protect only the stand the runner creates; none of them is a value from the dev store. The
store reaches the pod in the same way as on #28: Pulumi writes a K8s Secret (`data`, base64), and
the containers read it as files (`NAME_FILE`). `scripts/ci/manifest.sh` counts how many times any
store value appears in the workloads (Deployments, StatefulSets, Jobs, Services), both as plain text
and as base64, and the count must be 0.
Base64 is not encryption: putting the value in a Secret means it is not in git, not that it is
encrypted.

| Variable | Store | What it is for |
| --- | --- | --- |
| `DB_PASSWORD` | **сховище** (#11): `secrets/db_password` locally, `store/ci.enc` in CI; exported by `with-secrets.sh` | the database password. It reaches the pods through the K8s Secret `marketplace-api-secrets`, mounted as files |
| `BROKER_PASSWORD`, `STORAGE_SECRET_KEY`, `JWT_*`, `REFRESH_TOKEN_PEPPER`, `PAYMENT_WEBHOOK_SECRET` | `store/ci.enc` (added by `scripts/store-ci.sh fill`) | the rest of what the API, relay and consumer need in kind; the webhook key also signs the contour smoke |
| `PULUMI_CONFIG_PASSPHRASE` | **сховище** (#11): `secrets/pulumi_passphrase` locally, `store/ci.enc` in CI | encrypts the Pulumi state, which holds the Secret's value |
| `STORE_KEY` | the key **to** the store, not a value in it: `secrets/ci_store_key` locally, the `kind` environment's secret in CI | decrypts `store/ci.enc`, and is dropped before the wrapped command runs |

### Where masking ends

Masking is not protection. The runner replaces the exact characters of each registered value in
the log, and nothing else. A value that has been base64-encoded, URL-encoded, split across two
lines, cut with `cut`, or passed to a tool that prints it its own way (a `curl -v` header, a
stack trace that quotes an argument, `set -x` with a value that became part of a longer
string) is a different string, and goes into the log as it is. Only values that came from
`secrets.*` are registered at all. The values from `store/ci.enc` are decrypted inside a process,
so the runner never learns them and cannot mask them.

The protection is that nothing prints a secret. There is no `echo "$SECRET"`, `env`, `printenv`
or `set -x` in any step that can see one. The OIDC token goes to a 0600 file and is removed by a
`trap`. The gate prints its claims, not the token. `manifest.sh` prints a count, not the value.
The secret value is checked against the manifest by the step that knows it, and only the number
leaves the job. This is the sixth way a secret can leak, after the five closed on #11 (git
history, the app log, an image layer, `docker inspect`, `docker history`): the pipeline log.

### The four steps of the quality ladder

| Step | Tool | Catches | Broken input in `demo:gates` |
| --- | --- | --- | --- |
| 1. types | `tsc --noEmit` + `eslint` (`eslint.config.mjs`) | a defect in my own code | `test/gates/types/broken.ts`: `env.PROT` (a typo in the type), `==` |
| 2. contract | `oasdiff breaking --fail-on ERR`, the PR base's `openapi.yaml` against the PR's | a change that breaks a client already on v1, whether or not its Pact consumer is known | the spec with `GET /products/{productId}` renamed away |
| 3. architecture | `dependency-cruiser` (`.dependency-cruiser.cjs`) | a forbidden import between modules | `test/gates/arch/src/products/leak.ts`: the catalog imports `OrdersService` |
| 4. image | `npm run scan`, Trivy with the #28 threshold | findings above the threshold | `SCAN_MAX=-1`, which no image passes (`99999` passes) |

**The modules do not reach into each other.** Step 3 is how this sentence is checked:

- `catalog-does-not-know-orders`: orders depend on the catalog (an order line needs a product),
  never the other way round. Nothing in `products`, `files`, `storage`, `auth`, `entities`,
  `repositories`, `common`, `config`, `db`, `observability` or `cache` imports `orders` or
  `realtime`.
- `storage-only-through-files`: the S3 client is an internal detail of the `files` module.
  Other modules ask `files`.
- `leaves-stay-leaves`: `entities` and `observability` are imported by everyone and import no
  other module.

None of the steps has `continue-on-error` or `|| true`. A step with either one cannot fail, so it
would not be a gate.

### demo:rollout as a merge condition

After `pulumi up`, the deploy job runs the #28 script unchanged: `npm run demo:rollout` with
`STORE_SLUG=ci`, the same `demo/rollout.sh` and the same `scripts/load.mjs`, which writes one
status code per line. The script changes `REV` in the pod template, which starts a rollout, and
it counts `requests`, `ok` and `failed` from that file. `failed ≠ 0` or `requests < 2000`
(`MIN_REQUESTS=2000`, lower than #28's 5,000 because a runner is slower than a laptop and also
runs the cluster) gives a non-zero exit. That fails the job, which fails the PR.

### Cost gate

`pulumi preview --json` runs in the deploy job before `pulumi up`. The infrastructure change
appears in the PR's checks next to the code change, and its output becomes `plan.json` in the
artifact. `npm run gate:cost` reads it:

```
plan-usd    the monthly cost of the state the plan leads to, computed by src/mapping.ts
base-usd    the cost of the state it starts from (the oldState of each step)
budget-usd  COST_BUDGET_USD when given, otherwise base-usd + max($10, 20 %)
gate        pass when plan-usd <= budget-usd; fail exits 1
```

The default budget follows the change, not the total. An absolute limit would break on the first
expensive resource and keep every later PR red. In CI the stack is created fresh in each run, so
the `oldState` of `plan.json` is always empty. The base therefore comes from a second preview:
`scripts/ci/base-plan.sh` checks out the PR's base commit (`base.sha`; on main, `event.before`)
as a worktree and previews its own `infra/` into an empty stack with its own backend. That gives
`base-plan.json`, and `base-usd` is what it leads to (`BASE_PLAN_JSON`, `base-source=base-plan`).
A base without a Pulumi program has an empty plan and `base-usd=0`. Today base and head are both
3 replicas: `base-usd=5.04`, `delta-usd=0.00`, budget $15.04. One replica costs $1.68, so going
from 3 replicas to 8 passes (+$8.40) and going to 9 fails (+$10.08).

**Bypass.** If the PR has the label `cost-approved`, the gate still prints `gate=fail` with
`bypass=cost-approved` on the next line and exits 0. The verdict is still recorded in the log;
the label only stops it from blocking. The label name is on the `cost-gate-bypass-label:` line at
the top of this section.

The contract gate has the same kind of bypass, the label `breaking-approved`, added for the
coursework PR (#24). That PR renames the order statuses (`created` → `pending`, plus `confirmed`),
which oasdiff rightly reports as a break, and without the label the deploy job behind the gates
never runs. With the label the job prints `gate=fail` and then `bypass=breaking-approved`. Only
oasdiff's exit 1 (ERR found) is let through. A missing or unreadable spec (exit 2) still fails.

**Rates** (`RATES` in `src/mapping.ts`). kind bills nothing, so the price is what the same
requests would cost elsewhere: the pod requests priced as AWS Fargate pods, plus the two
Kubernetes objects that become a bill on any cloud.

| What | Rate | Source |
| --- | --- | --- |
| vCPU of `resources.requests.cpu` | $0.04048 per vCPU-hour | [AWS Fargate pricing](https://aws.amazon.com/fargate/pricing/), Linux/x86, us-east-1 |
| GiB of `resources.requests.memory` | $0.004445 per GB-hour | same |
| `Service` of type `LoadBalancer` | $0.0225 per hour (NLB) | [Elastic Load Balancing pricing](https://aws.amazon.com/elasticloadbalancing/pricing/) |
| `PersistentVolumeClaim` storage | $0.08 per GB-month (gp3) | [Amazon EBS pricing](https://aws.amazon.com/ebs/pricing/) |
| Month | 730 hours | |

Today's plan: 3 replicas × (50m CPU + 64Mi) = **$5.04/month**. The Service is a NodePort, so it
costs nothing.

### The artifact pipeline-evidence

The `evidence` job runs with `if: always()`, so a red run has evidence too. It collects what
`build` and `deploy` uploaded:

| File | Contents |
| --- | --- |
| `evidence.txt` | `run-id`, `head-sha` (`github.event.pull_request.head.sha`, not the merge commit), `image-ref`, `built-digest`, `deployed-digest`, `build-invocations`, `creds-source` (`oidc` only when `policy-allow=1`), `oidc-iss/aud/sub/sig-verified`, `rollout-requests/ok/failed/seconds`, `secrets-checked`, `secret-in-manifest`, `contour-final`, `contour-history`, `gate-scan-exit`, plus the cost lines |
| `deployment.json` | `kubectl get deploy marketplace-api -o json` after `demo:rollout`, the state the run left (generation 2, `REV=2`); checked again for digest and secret |
| `plan.json` | `pulumi preview --json`, the input to the cost gate |
| `base-plan.json` | the same preview of the base commit's program, the cost gate's base |
| `rollout.txt` | the raw output of `demo:rollout` |
| `contour.txt` | the raw output of `demo/contour.mjs` against the API in kind |
| `build.log` | one line per build in this run |

None of the numbers is typed in by hand. `rollout-*` come from the file the load generator
writes. `built-digest` comes from the build step's output. `deployed-digest` and
`secret-in-manifest` come from the Deployment read back from the cluster. `plan-usd` comes from
`plan.json`, and `oidc-sig-verified` comes from the signature check. If one of these is missing,
its key is left out of `evidence.txt` rather than replaced with a default.

### Commands

```bash
npm run demo:gates     # four steps × (ok, broken): <step>-ok=0, <step>-broken≠0
npm run demo:oidc      # green 1 1 · foreign-sub 1 0 · bad-signature 0 0
PLAN_JSON=plan.json COST_BUDGET_USD=0 npm run gate:cost   # gate=fail, exit 1
npm run gate:types | gate:arch                            # one step, as CI runs it
npm run gate:contract -- <base.yaml> <revision.yaml>
STORE_SLUG=ci STORE_KEY=$(cat secrets/ci_store_key) npm run plan   # what CI previews
bash scripts/store-ci.sh names                            # the names in store/ci.enc, never the values
```

# The OpenAPI contract in detail

## What the spec contains

**3 resources, 7 operations:**

| Operation | `operationId` | Handler |
| --- | --- | --- |
| `GET /health` | `getHealth` | `HealthController.get` |
| `GET /products` | `listProducts` | `ProductsController.list` |
| `POST /products` | `createProduct` | `ProductsController.create` |
| `GET /products/{productId}` | `getProduct` | `ProductsController.get` |
| `GET /orders` | `listOrders` | `OrdersController.list` |
| `POST /orders` | `createOrder` | `OrdersController.create` |
| `GET /orders/{orderId}` | `getOrder` | `OrdersController.get` |

* **Cursor pagination** on both list operations: query `limit` (1..100, default 20)
  and `cursor`. The response is `{ items, next_cursor }`, where `next_cursor: null`
  means there are no more pages. The cursor is opaque: the implementation happens to
  use base64url of `offset:<n>`, but that is an implementation detail and clients
  have no right to parse it.
* **Idempotency-Key** — a header parameter with `required: true` on both POST
  operations. It is `required: true` that lets the validator demand the header
  instead of an `if` in a controller.
* **problem+json** — every 4xx/5xx response is served as `application/problem+json`
  with the `Problem` schema (`type`, `title`, `status`, `detail`, `instance`, all required).
* **Money is integer cents:** `price_cents`, `unit_price_cents`, `total_cents` are
  all `integer`. No floats and no decimal strings like `"2600.00"`.

The API deliberately has no authentication yet, so the root carries an explicit
`security: []` — without it the redocly `security-defined` rule raises an error and
`lint` exits with code 1.

## How the boundary is wired into Nest

The middleware order in `src/bootstrap.ts` is the whole point of option B:

```
express.json()  →  OpenApiValidator  →  Nest router  →  problem+json
```

Three details make it work, and each one is a trap if you miss it:

1. **Nest's own body parser is switched off** (`NestFactory.create(AppModule, { bodyParser: false })`).
   Nest registers it during `app.init()`, which runs *after* our `app.use()` calls,
   so the validator would otherwise inspect an unparsed body. We mount
   `express.json()` ourselves, ahead of the validator.
2. **Two error paths, one mapping.** The validator rejects requests *before* Nest's
   pipeline runs, so its errors never reach a Nest exception filter — they surface
   as Express errors. `ProblemFilter` covers everything raised inside Nest
   (controllers, services, the response validator); an Express error middleware
   registered after `app.init()` covers the validator. Both call the same
   `toProblem()`, so the wire format cannot diverge.
3. **`incremental` is off in `tsconfig.json`.** Combined with `deleteOutDir: true`
   it produces an empty `dist/`: `tsc` sees an up-to-date `.tsbuildinfo`, emits
   nothing, and Nest has already deleted the output.

## Verifying the acceptance criteria with raw commands

### 1. Spec is valid (exit code 0)

```bash
npx @redocly/cli lint openapi/openapi.yaml
echo $?   # 0
```

One warning (`no-server-example.com` for `http://localhost:3000`) is expected:
warnings are allowed, errors are not.

### 2. Spec size

```bash
npx @redocly/cli bundle openapi/openapi.yaml -o spec.json

node -e "const s=require('./spec.json'),M=['get','post','put','patch','delete'];\
const ops=Object.entries(s.paths).flatMap(([p,v])=>Object.keys(v).filter(m=>M.includes(m)).map(m=>[p,m]));\
const idem=ops.flatMap(([p,m])=>s.paths[p][m].parameters??[]).find(x=>x.in==='header'&&/idempotency-key/i.test(x.name));\
console.log('операцій:',ops.length,'· ресурсів:',new Set(Object.keys(s.paths).map(p=>p.split('/')[1])).size);\
console.log('Idempotency-Key: required =',idem?.required,'· опис, символів =',(idem?.description??'').trim().length)"
```

The `node -e` snippet is reproduced verbatim from the assignment, so its output
labels are in Ukrainian. Actual output:

```
операцій: 7 · ресурсів: 3
Idempotency-Key: required = true · опис, символів = 412
```

Parameters are written inline in the operations on purpose, rather than via
`$ref: '#/components/parameters/...'`: `redocly bundle` keeps `$ref`s in its output,
so the check above would have seen `{ $ref: ... }` instead of `in`/`name`/`required`.

### 3–5. Grep criteria

```bash
grep -c 'Idempotency-Key' openapi/openapi.yaml          # 8  (>= 1)
grep -c 'next_cursor' openapi/openapi.yaml              # 8  (>= 1)
grep -c 'application/problem+json' openapi/openapi.yaml # 7  (>= 2)
```

### 6. The contract part works (option B)

Start the server with `npm run start:vault`, then in another terminal. *Since the auth
homework* the `/orders` routes need a token — add `-H "Authorization: Bearer $TOKEN"`
(how to get one: [The SSE side by hand](#the-sse-side-by-hand)) to every request below
except the first, which the spec validator still answers with 400 before any guard runs:

**Without `Idempotency-Key` → 400 `application/problem+json`** (the header is demanded
by the spec, not by an `if` in a controller):

```bash
curl -i -X POST localhost:3000/orders \
  -H 'Content-Type: application/json' \
  -d '{"items":[{"product_id":"p_1","qty":2}]}'
```

```
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json; charset=utf-8

{"type":"https://marketplace.example/problems/validation-error","title":"Bad Request",
 "status":400,"detail":"request/headers must have required property 'idempotency-key'",
 "instance":"/orders"}
```

The `detail` says `'idempotency-key'` in lowercase: the validator looks header
parameters up in `req.headers`, and Node lowercases header names. The spec itself
still spells the header the conventional way — `Idempotency-Key`.

**Invalid body (empty `items`) → 400 with a detail from the validator:**

```bash
curl -i -X POST localhost:3000/orders \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 6f1f8f4e-4d4b-4a53-9a0e-2c1f0b7a1c11' \
  -d '{"items":[]}'
```

```
HTTP/1.1 400 Bad Request
detail: "request/body/items must NOT have fewer than 1 items"
```

**Valid request → 201:**

```bash
curl -i -X POST localhost:3000/orders \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 6f1f8f4e-4d4b-4a53-9a0e-2c1f0b7a1c11' \
  -d '{"items":[{"product_id":"p_1","qty":2}]}'
```

```
HTTP/1.1 201 Created

{"id":"o_1","status":"created","currency":"UAH",
 "items":[{"product_id":"p_1","qty":2,"unit_price_cents":260000}],
 "total_cents":520000,"created_at":"..."}
```

## Extra challenge: full Idempotency-Key semantics

**Same key + same body → the same 201 plus `Idempotency-Replay: true`**
(no new order is created, the same `id` comes back):

```bash
curl -i -X POST localhost:3000/orders \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 6f1f8f4e-4d4b-4a53-9a0e-2c1f0b7a1c11' \
  -d '{"items":[{"product_id":"p_1","qty":2}]}'
```

```
HTTP/1.1 201 Created
Idempotency-Replay: true
```

**Same key + a different body → 422 `application/problem+json`:**

```bash
curl -i -X POST localhost:3000/orders \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 6f1f8f4e-4d4b-4a53-9a0e-2c1f0b7a1c11' \
  -d '{"items":[{"product_id":"p_2","qty":9}]}'
```

```
HTTP/1.1 422 Unprocessable Entity
Content-Type: application/problem+json; charset=utf-8

{"type":"https://marketplace.example/problems/idempotency-key-reuse",
 "title":"Unprocessable Entity","status":422,
 "detail":"Idempotency-Key '6f1f8f4e-...' was already used with a different request body.",
 "instance":"/orders"}
```

`IdempotencyService` compares request bodies by their sha256 fingerprint and stores
keys per route, so `POST /orders` and `POST /products` never collide with each other.

## Cursor pagination in action

```bash
curl -s 'localhost:3000/products?limit=3'
# {"items":[p_1,p_2,p_3],"next_cursor":"b2Zmc2V0OjM"}

curl -s 'localhost:3000/products?limit=3&cursor=b2Zmc2V0OjM'
# {"items":[p_4,p_5,p_6],"next_cursor":"b2Zmc2V0OjY"}

curl -s 'localhost:3000/products?limit=100'
# {"items":[...all 7...],"next_cursor":null}   ← no more pages
```

## Why `validateResponses: true`

A spec on its own enforces nothing. The boundary enforces it in both directions:

```ts
OpenApiValidator.middleware({
  apiSpec: API_SPEC,
  validateRequests: true,   // an invalid request never reaches a controller
  validateResponses: true,  // an invalid response never reaches the client
})
```

Verified against real drift: rename `total_cents` to `totalCents` in
`OrdersService.create` — the classic refactoring slip — and the app no longer serves
an "almost correct" 201:

```
HTTP/1.1 500 Internal Server Error
{"type":"https://marketplace.example/problems/internal-server-error",
 "title":"Internal Server Error","status":500,
 "detail":"/response must have required property 'total_cents'","instance":"/orders"}
```

This is the runtime counterpart of the lecture's `contract/check.mjs` that caught `DRIFT=1`.

## Layout

```
openapi/openapi.yaml              the spec: 6 resources, 17 operations, bearerAuth
src/main.ts                       entry point
src/bootstrap.ts                  Nest app + validator boundary + error wiring
src/app.module.ts                 root module: ConfigModule.forRoot({ validate })
src/config/env.schema.ts          zod schema + validate (fail-fast), key checks, no defaults for secrets
src/auth/                         ES256 tokens, refresh rotation + reuse detection, denylist, guards, demo kit
src/demo-auth.ts / demo-reuse.ts / demo-rbac.ts  the three auth demos
src/storage/                      S3 client (endpoint or AWS), ensureBucket + lifecycle, Nest provider
src/files/                        intent / parts / commit / download, upload plan, assets, keyless clients, demo kit
src/edge.ts                       the edge cache in front of the private bucket, X-Cache: HIT|MISS
src/demo-upload.ts / demo-multipart.ts / demo-cdn.ts  the three file demos
src/data-source.ts                TypeORM DataSource: synchronize false, env-only credentials
src/entities/                     User, Product, Order, OrderItem — the schema in code
src/migrations/                   the generated (and hand-corrected) initial schema
src/seed.ts                       deterministic idempotent fixtures
src/concurrency/checkout.ts       the transactional checkout operation
src/concurrency/worker.ts         queue worker: claim with FOR UPDATE SKIP LOCKED
src/concurrency/retry.ts          retry wrapper for 40001 / 40P01 with backoff
src/concurrency/sql.ts            RETURNING rows out of UPDATE through the query runner
src/demo-race.ts                  50 parallel checkouts + invariant checks
src/demo-workers.ts               worker pool + distribution and timing report
src/demo-retry.ts                 serialization failures, retries, final arithmetic
src/demo-nplus1.ts                N+1 before/after with a query counter
src/report.ts                     revenue per seller through createQueryBuilder()
src/repositories/                 data access taking anything with query(): pool, client or transaction
src/db/query-count-logger.ts      TypeORM Logger that counts and prints queries
src/db/database.module.ts         pg.Pool with password: () => readFile()
src/health/health.controller.ts   /health, reports uptime and pid
src/common/problem.ts             Problem types and the shared toProblem() mapping
src/common/problem.filter.ts      Nest exception filter → application/problem+json
src/common/cursor.ts              opaque cursor encode/decode + paginate
src/common/idempotency.service.ts replay semantics for Idempotency-Key
src/products/                     ProductsController + ProductsService (Postgres)
src/orders/                       OrdersController + OrdersService: status change, SSE stream
src/realtime/order-events.service.ts  the bus: Subject + per-order sequence and replay buffer
src/realtime/orders.gateway.ts    WebSocket gateway: join, room orders:<id>, owner check
src/realtime/order-access.ts      the one ownership rule both transports apply
src/messaging/events.ts           the order.placed contract: envelope, stable eventId, parser
src/messaging/topology.ts         exchange, queue, binding, DLX + DLQ — declared by the consuming side
src/messaging/publisher.ts        confirm channel + mandatory: "published" means the broker said so
src/messaging/order-placed.consumer.ts  manual ack after the effect, prefetch, ON CONFLICT DO NOTHING
src/messaging/broker.ts           BROKER_URL (+ password file) → amqplib connection
src/messaging/demo-kit.ts         clean slate, consumer child process, queue depths, key=value report
src/consumer.ts                   the consumer as its own process (JSON lines on stdout)
src/demo-publish.ts / demo-dlq.ts / demo-duplicate.ts  the three broker demos
src/outbox/outbox.ts              appendToOutbox(): the event row, inside the business transaction
src/outbox/relay.ts               one relay pass: FOR UPDATE SKIP LOCKED → publish → UPDATE published_at
src/relay.ts                      the relay as its own process (JSON lines on stdout)
src/orders/place-order-once.ts    Idempotency-Key claimed in the same transaction as the order
src/orders/checkout.http.ts       POST /checkout: 201 / 200 replay / 422 key reused with another body
src/demo-outbox.ts / demo-crash-write.ts / demo-crash-relay.ts  the three outbox demos
src/redis/connection.ts           REDIS_URL / REDIS_QUEUE_URL (+ password file) → ioredis, CONFIG GET
src/cache/cache-aside.ts          cache-aside: jittered TTL, SET NX PX single flight, compare-and-delete
src/cache/product-cards.ts        the product card behind the cache
src/repositories/counting.ts      CountingQueryable: statements actually sent to Postgres
src/sessions/                     Redis hash session store, rolling TTL in one Lua script, cookie middleware
src/ratelimit/sliding-window.ts   sliding-window log in one Lua script, 429 + Retry-After
src/queue/notifications.ts        BullMQ queue: attempts + exponential backoff, jobId dedup, job scheduler
src/pod.ts                        one stateless pod (sessions + limit) as its own process
src/common/demo-output.ts         key=value report, invariant checks, exit codes — no database import
src/observability/tracing.ts      OTel NodeSDK: http/express/pg instrumentation, OTLP exporter; first import of main.ts
src/observability/context.ts      AsyncLocalStorage of the request: userId, tenant, idempotencyKey, demo fault
src/observability/logger.ts       pino: JSON on stdout, trace_id/span_id + context in mixin, redact paths
src/observability/metrics.ts      prom-client registry: http_requests_total, http_request_duration_seconds, buckets
src/observability/request-log.ts  per-request line + RED observation; GET /metrics
src/observability/span.ts         inSpan(): a manual span that records the exception and ERROR
demo/logs.mjs / metrics.mjs / trace.mjs  the three observability demos; demo/lib/observed-api.mjs their kit
observability/                    compose of the stand, Prometheus config, Grafana provisioning + dashboard JSON
src/demo-cache.ts / demo-session.ts / demo-ratelimit.ts / demo-queue.ts  the four Redis demos
db/init.sql                       products table + seed, run by compose on first start
test/testkit/                     the container, the rollback isolation and the builders
test/integration/                 repository tests against a real Postgres
test/e2e/                         the whole application over HTTP through supertest
test/contract/                    Pact consumer test and provider verification
pacts/                            the generated contract, committed on purpose
jest.config.js                    integration suite; the other three configs extend it
.github/workflows/contract.yml    publish → verify → can-i-deploy
scripts/pact-gate.sh              the broker side: publish, tag, gate
scripts/with-secrets.sh           runs a command with credentials (and the token keys) from the store
scripts/jwt-keys.mjs              generate / rotate / retire / fingerprint the keys in secrets/jwt/<env>/
scripts/lib/pg-env.sh             environment → PG* variables, shared by the two scripts below
scripts/backup.sh                 pg_dump -Fc into a dated file + a control-value sidecar
scripts/restore-drill.sh          restores the newest dump into a throwaway container, prints MATCH
scripts/realtime-demo.mjs         room isolation, headless, with a --same-room control run
scripts/check-spec.js             acceptance criteria for the spec (npm run check)
scripts/check-env-example.mjs     .env.example vs schema (npm run check:env)
scripts/smoke.mjs                 acceptance criteria for the app (npm run smoke)
rotate.sh                         password rotation across Postgres, PgBouncer and the file
backup.cron                       the nightly schedule, and the weekly drill
RESTORE-DRILL.md                  the drill protocol: date, size, time, RTO, RPO
pgbouncer/pgbouncer.ini           transaction pooling + a session-mode alias for pg_dump
pgbouncer/userlist.txt            SCRAM credentials for the pooler (development values)
docker-compose.yml                PgBouncer on 56432, Postgres behind it on 55432, RabbitMQ on 5672/15672,
                                  Redis cache on 56379 (allkeys-lru), Redis queue on 56380 (noeviction + AOF),
                                  RustFS (S3 API) on 59000
Dockerfile / .dockerignore        image built without secrets in any layer
.env.example                      the variable contract; .env and secrets/ are ignored
```

Products live in Postgres — that is the request which proves the pool survives a
password rotation. Orders stay in memory on the HTTP side: they read product prices from
the database but persisting them adds nothing to the contract homework. The `orders` and
`order_items` tables are nevertheless real, and the ORM layer reads and reports on them;
wiring order placement through them is the next homework's transactional work.

## Versions

`@nestjs/*@10` is deliberate — it brings Express 4, and the assignment recommends
`express@4` because `express-openapi-validator` works with it without surprises.
Nest 11 would pull Express 5 instead.

| Package | Version |
| --- | --- |
| `@nestjs/common` / `core` / `platform-express` | 10.4.22 |
| `@nestjs/websockets` / `platform-socket.io` | 10.4.22 |
| `socket.io` / `socket.io-client` | 4.8.1 / 4.8.4 |
| `express` | 4.22.2 |
| `express-openapi-validator` | 5.6.2 |
| `@redocly/cli` | 2.46.0 |
| `typeorm` | 0.3.31 |
| `postgres` (image) | 16-alpine |
| `edoburu/pgbouncer` (image) | v1.25.2-p0 (PgBouncer 1.25) |
| `pactfoundation/pact-broker` (image) | 2.143.0-pactbroker2.121.0 |
| `jest` / `ts-jest` | 30 / 29 |
| `@testcontainers/postgresql` | 12.x |
| `@pact-foundation/pact` | 17.x |
| `supertest` | 7.x |
| `pg` | 8.x |
| `bullmq` / `ioredis` | 6.x / 5.x (5, not 6: `typeorm` 0.3 has an optional peer on `ioredis@^5`) |
| `redis` (image) | 8.4-alpine |
| `@aws-sdk/client-s3` / `s3-request-presigner` | 3.x (`requestChecksumCalculation: 'WHEN_REQUIRED'`) |
| `rustfs/rustfs` (image) | 1.0.4 |
| `jsonwebtoken` | 9.x (ES256 with a `KeyObject`; `algorithms` allowlist on verify) |
| `pino` / `prom-client` | 10.4.0 / 15.1.3 |
| `@opentelemetry/sdk-node` / `instrumentation-http` / `exporter-trace-otlp-http` | 0.301.2 (SDK 3.1.1, `@opentelemetry/api` 1.10; v3 renamed `sdk-trace-base` to `sdk-trace`, whose `BatchSpanProcessor` takes `{ exporter }`) |
| `@opentelemetry/instrumentation-express` / `instrumentation-pg` | 0.73.0 / 0.78.0 |
| `prom/prometheus` / `grafana/grafana` / `jaegertracing/jaeger` (images) | v3.5.0 / 12.1.1 / 2.10.0 |
| `typescript` | 5.x |

The build is plain `tsc` (through `nest build`) on purpose: esbuild-based transpilers do not
emit decorator metadata, and without it every TypeORM decorator loses the type it describes.
