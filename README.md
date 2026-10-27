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
cp .env.example .env                 # real values live here; .env is git-ignored
cp secrets/db_password.example secrets/db_password
cp secrets/redis_password.example secrets/redis_password
docker compose up -d --wait          # PgBouncer 56432, Postgres behind it, RabbitMQ 5672, Redis 56379/56380, Pact broker 9292
npm run build                        # migrations and scripts run from dist/
npm run migrate && npm run seed      # schema from src/migrations + fixture rows
npm start                            # http://localhost:3000
```

The database schema comes from the TypeORM migrations — `npm run db:schema` and
`npm run db:seed` are the raw-SQL path of the data-layer homework and belong to the
`EXPLAIN` exercise below, not to running the app.

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
| `npm run pod` | one stateless API pod: sessions (`GET /session`) and the rate limit (`GET /limited`) |
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

| Variable | Required | Default | Source | Purpose |
| --- | --- | --- | --- | --- |
| `NODE_ENV` | no | `development` | process environment | Runtime mode: `development` \| `test` \| `production`. |
| `PORT` | no | `3000` | process environment | HTTP port. Coerced to a number. |
| `DB_URL` | **yes** | — | **secrets store** — the local `.env`, which is git-ignored; `.env.example` carries a fake | Postgres connection string **without a password**. The schema rejects a URL that contains one. |
| `DB_PASSWORD_FILE` | no | `./secrets/db_password` | process environment (a path, not a secret) | File holding the database password. Re-read on every new connection. |
| `DB_POOL_MAX` | no | `10` | process environment | Maximum connections in the pool. |
| `DB_CONNECTION_TIMEOUT_MS` | no | `5000` | process environment | How long to wait for a pooled connection. |
| `LOG_LEVEL` | no | `info` | process environment | `debug` \| `info` \| `warn` \| `error`. |

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

```bash
docker compose up -d --wait
export DATABASE_URL=postgres://marketplace:marketplace_dev_password@127.0.0.1:56432/marketplace
export BROKER_URL=amqp://marketplace:marketplace_dev_password@127.0.0.1:5672
export REDIS_URL=redis://:redis_dev_password@127.0.0.1:56379        # the cache: allkeys-lru
export REDIS_QUEUE_URL=redis://:redis_dev_password@127.0.0.1:56380  # queue, sessions, limits: noeviction
export SKIP_VAULT=1    # the grader has no access to the secret store
npm ci
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
npm run test:integration            # 8 tests, two repositories, real Postgres
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
| `npm run test:integration` | repositories, 8 tests | a real Postgres started by the test run |
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

`.github/workflows/contract.yml` runs one job, `contract`: compile → integration → e2e →
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
npm start                            # http://localhost:3000, WebSocket on the same port
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

`POST /orders` records the `X-User-Id` header as the order's `buyer_id`. From then on
`src/realtime/order-access.ts` is the one rule both transports apply:

| Order | Listener | Result |
| --- | --- | --- |
| `buyer_id: "u_demo"` | `u_demo` | joins `orders:<id>` / streams |
| `buyer_id: "u_demo"` | `u_other` | refused — `forbidden` |
| `buyer_id: "u_demo"` | no identity | refused — `anonymous` |
| `buyer_id: null` | anyone | public stream |

An order created **without** `X-User-Id` has no buyer, and its stream is public —
that is what makes `curl http://localhost:3000/orders/o_1/events` work with no
credentials. Anything with a buyer is private on both transports. WebSocket identity
comes from the handshake (`io(url, { auth: { userId } })`); SSE takes `X-User-Id`, or
`?userId=` for a browser `EventSource`, which cannot set headers.

## The SSE side by hand

```bash
ORDER=$(curl -s -X POST http://localhost:3000/orders \
  -H 'Content-Type: application/json' -H "Idempotency-Key: readme-$(date +%s)" \
  -d '{"items":[{"product_id":"p_1","qty":2}]}' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')

curl -sN --max-time 2 -D - -o /dev/null http://localhost:3000/orders/$ORDER/events | grep -i '^content-type'
# Content-Type: text/event-stream

curl -sN --max-time 5 http://localhost:3000/orders/$ORDER/events &
curl -s -X PATCH http://localhost:3000/orders/$ORDER/status \
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
openapi/openapi.yaml              the spec: 3 resources, 9 operations
src/main.ts                       entry point
src/bootstrap.ts                  Nest app + validator boundary + error wiring
src/app.module.ts                 root module: ConfigModule.forRoot({ validate })
src/config/env.schema.ts          zod schema + validate (fail-fast)
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
scripts/with-secrets.sh           runs a command with credentials from the store
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
                                  Redis cache on 56379 (allkeys-lru), Redis queue on 56380 (noeviction + AOF)
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
| `typescript` | 5.x |

The build is plain `tsc` (through `nest build`) on purpose: esbuild-based transpilers do not
emit decorator metadata, and without it every TypeORM decorator loses the type it describes.
