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
docker compose up -d --wait          # Postgres on localhost:55432
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
| `npm run db:schema` | *(raw-SQL path of the data-layer homework)* applies `db/schema.sql` |
| `npm run db:seed` | applies `db/seed.sql` (≈590 000 rows, ends with `VACUUM (ANALYZE)`) |
| `npm run db:indexes` | applies `db/indexes.sql` + `ANALYZE` |
| `npm run db:psql` | opens a psql shell on the running container |
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
export DB_HOST=127.0.0.1 DB_PORT=55432 DB_USER=marketplace DB_PASSWORD=marketplace_dev_password DB_NAME=marketplace
export SKIP_VAULT=1    # the grader has no access to the secret store
```

Those are the dev credentials from `docker-compose.yml` (port `55432`, because the compose
file maps `55432:5432`), and by the rules of the configuration homework they are not a
secret. With them exported, every command runs on a fresh clone:

```bash
npm ci && npx tsc --noEmit          # clean compile
npm run build                       # tsc → dist/, including dist/migrations/*.js
npm run migrate && npm run migrate:show
npm run migrate:revert && npm run migrate
npm run seed && npm run seed        # idempotent: same row counts twice
npm run demo:nplus1                 # query counts before/after
npm run report                      # aggregate through QueryBuilder
```

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
openapi/openapi.yaml              the spec: 3 resources, 7 operations
src/main.ts                       entry point
src/bootstrap.ts                  Nest app + validator boundary + error wiring
src/app.module.ts                 root module: ConfigModule.forRoot({ validate })
src/config/env.schema.ts          zod schema + validate (fail-fast)
src/data-source.ts                TypeORM DataSource: synchronize false, env-only credentials
src/entities/                     User, Product, Order, OrderItem — the schema in code
src/migrations/                   the generated (and hand-corrected) initial schema
src/seed.ts                       deterministic idempotent fixtures
src/demo-nplus1.ts                N+1 before/after with a query counter
src/report.ts                     revenue per seller through createQueryBuilder()
src/db/query-count-logger.ts      TypeORM Logger that counts and prints queries
src/db/database.module.ts         pg.Pool with password: () => readFile()
src/health/health.controller.ts   /health, reports uptime and pid
src/common/problem.ts             Problem types and the shared toProblem() mapping
src/common/problem.filter.ts      Nest exception filter → application/problem+json
src/common/cursor.ts              opaque cursor encode/decode + paginate
src/common/idempotency.service.ts replay semantics for Idempotency-Key
src/products/                     ProductsController + ProductsService (Postgres)
src/orders/                       OrdersController + OrdersService (in-memory)
db/init.sql                       products table + seed, run by compose on first start
scripts/with-secrets.sh           runs a command with credentials from the store
scripts/check-spec.js             acceptance criteria for the spec (npm run check)
scripts/check-env-example.mjs     .env.example vs schema (npm run check:env)
scripts/smoke.mjs                 acceptance criteria for the app (npm run smoke)
rotate.sh                         database password rotation without a restart
docker-compose.yml                Postgres for local development
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
| `express` | 4.22.2 |
| `express-openapi-validator` | 5.6.2 |
| `@redocly/cli` | 2.46.0 |
| `typeorm` | 0.3.31 |
| `pg` | 8.x |
| `typescript` | 5.x |

The build is plain `tsc` (through `nest build`) on purpose: esbuild-based transpilers do not
emit decorator metadata, and without it every TypeORM decorator loses the type it describes.
