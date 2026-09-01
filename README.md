# Marketplace API — Homework 09: contract first

Chosen contract option: **B — runtime validation at the boundary**
(NestJS + `express-openapi-validator`).

`openapi/openapi.yaml` is not documentation sitting next to the code — it is the
source of truth the validator checks **both requests and responses** against.
Anything that contradicts the spec does not cross the boundary: an invalid request
is rejected before it reaches a controller (400), and a response that has drifted
away from its schema never reaches the client (500 instead of silent drift).

## Quick start

```bash
npm install
cp .env.example .env          # real values live here; .env is git-ignored
docker compose up -d --wait   # Postgres on localhost:55432, seeded from db/init.sql
npm start                     # http://localhost:3000
```

`npm start` is `npm run build && node dist/main.js` on purpose — not a watch mode.
A watcher never exits, so it can never report a non-zero exit code, and the
fail-fast criterion below would be untestable. Watch mode lives in `npm run start:dev`.

## Commands

| Command | What it does |
| --- | --- |
| `npm start` | builds and runs the app on the configured `PORT` |
| `npm run start:dev` | watch mode (`nest start --watch`) |
| `npm run build` | compiles TypeScript into `dist/` |
| `npm run check:env` | verifies `.env.example` still matches the zod schema |
| `npm run lint` | `redocly lint openapi/openapi.yaml` |
| `npm run bundle` | `redocly bundle openapi/openapi.yaml -o spec.json` |
| `npm run check` | every acceptance criterion for the spec in one run |
| `npm run smoke` | builds, then runs every contract criterion against the live app (needs Postgres up) |

`npm run check` and `npm run smoke` perform exactly the same checks as the raw
commands below, just collected into one run with readable output.

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

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `NODE_ENV` | no | `development` | Runtime mode: `development` \| `test` \| `production`. |
| `PORT` | no | `3000` | HTTP port. Coerced to a number. |
| `DB_URL` | **yes** | — | Postgres connection string **without a password**. The schema rejects a URL that contains one. |
| `DB_PASSWORD_FILE` | no | `./secrets/db_password` | File holding the database password. Re-read on every new connection. |
| `DB_POOL_MAX` | no | `10` | Maximum connections in the pool. |
| `DB_CONNECTION_TIMEOUT_MS` | no | `5000` | How long to wait for a pooled connection. |
| `LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error`. |

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

`rotate.sh` does three things, and the order is the whole point:

1. `ALTER ROLE` — the database learns the new password first.
2. Write `secrets/db_password` — new connections start using it.
3. `pg_terminate_backend` — connections opened with the old password are dropped, and
   the pool transparently reopens them.

Writing the file first would leave a window where every new connection authenticates
with a password the database does not know yet.

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

Start the server with `npm start`, then in another terminal:

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
openapi/openapi.yaml              the spec: 3 resources, 7 operations
src/main.ts                       entry point
src/bootstrap.ts                  Nest app + validator boundary + error wiring
src/app.module.ts                 root module: ConfigModule.forRoot({ validate })
src/config/env.schema.ts          zod schema + validate (fail-fast)
src/db/database.module.ts         pg.Pool with password: () => readFile()
src/health/health.controller.ts   /health, reports uptime and pid
src/common/problem.ts             Problem types and the shared toProblem() mapping
src/common/problem.filter.ts      Nest exception filter → application/problem+json
src/common/cursor.ts              opaque cursor encode/decode + paginate
src/common/idempotency.service.ts replay semantics for Idempotency-Key
src/products/                     ProductsController + ProductsService (Postgres)
src/orders/                       OrdersController + OrdersService (in-memory)
db/init.sql                       products table + seed, run by compose on first start
scripts/check-spec.js             acceptance criteria for the spec (npm run check)
scripts/check-env-example.mjs     .env.example vs schema (npm run check:env)
scripts/smoke.mjs                 acceptance criteria for the app (npm run smoke)
rotate.sh                         database password rotation without a restart
docker-compose.yml                Postgres for local development
Dockerfile / .dockerignore        image built without secrets in any layer
.env.example                      the variable contract; .env and secrets/ are ignored
```

Products live in Postgres — that is the request which proves the pool survives a
password rotation. Orders stay in memory: they read product prices from the database
but persisting them adds nothing to what this homework demonstrates.

## Versions

`@nestjs/*@10` is deliberate — it brings Express 4, and the assignment recommends
`express@4` because `express-openapi-validator` works with it without surprises.
Nest 11 would pull Express 5 instead.

| Package | Version |
| --- | --- |
| `@nestjs/common` / `core` / `platform-express` | 10.4.22 |
| `express` | 4.22.2 |
| `express-openapi-validator` | 5.6.2 |
| `@redocly/cli` | 2.46.0 |
| `typescript` | 5.x |
