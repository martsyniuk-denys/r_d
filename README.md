# Todo API

Express + TypeScript + PostgreSQL backend for a Todo app.

## Structure

| File                          | Purpose                                                    |
| ------------------------------ | ----------------------------------------------------------- |
| `Dockerfile`                   | multi-stage build, non-root user, healthcheck               |
| `.dockerignore`                 | excludes `node_modules`, `.git`, `.env`, etc.                |
| `docker-compose.yml`            | base stack, CI-safe (no bind mounts, no published ports)    |
| `docker-compose.override.yml`   | dev mode: bind mount, hot-reload, published port            |
| `src/`                          | the service (Todo REST API)                                 |
| `README.md`                     | run commands, image sizes, how persistence was verified     |

**`docker compose up -d` alone — no file edits — brings up the full stack** (api + postgres),
since `docker compose` merges `docker-compose.override.yml` on top of `docker-compose.yml`
automatically whenever both files are present and no `-f` flag is given.

## Setup

```
npm install
cp .env.example .env   # set DATABASE_URL to your Postgres instance
npm run migrate        # creates the todos table (or: psql "$DATABASE_URL" -f db/schema.sql)
npm run dev            # http://localhost:3000
```

## Endpoints

| Method | Path         | Body                                   | Description             |
| ------ | ------------ | --------------------------------------- | ------------------------ |
| GET    | `/health`    | —                                        | Liveness check            |
| GET    | `/todos`     | —                                        | List all todos           |
| POST   | `/todos`     | `{ "title": string, "completed"?: bool }` | Create a todo            |
| PUT    | `/todos/:id` | `{ "title"?: string, "completed"?: bool }` | Update an existing todo  |

## Docker

### Run it (dev mode, override applied automatically)

```
docker compose up -d
```

No prior setup or file edits needed. This picks up `docker-compose.override.yml` on top of
`docker-compose.yml` automatically: it builds the `builder` stage (dev deps included), runs
`npm run dev` (ts-node-dev hot-reload), bind-mounts `./src` and `tsconfig.json` into the
container so edits on the host restart the server immediately, and publishes port 3000 to
the host. Postgres starts with a named volume and the api waits for its
`service_healthy` condition. Once up:

```
curl http://localhost:3000/health   # {"status":"ok"}
curl http://localhost:3000/todos    # []
```

### CI / production (`docker-compose.yml` only, no override)

```
docker compose -f docker-compose.yml up -d --build
```

Builds the `runner` stage, runs the API as the non-root `node` user, waits for Postgres's
`service_healthy` condition before starting, and applies `db/schema.sql` automatically via
Postgres's `docker-entrypoint-initdb.d`. No ports are published in this file and nothing is
bind-mounted — it's meant to run as a self-contained stack in CI, not to be browsed from the
host. Verify with `docker compose -f docker-compose.yml config` (resolves cleanly, no
`./src` bind mount present).

### Verifying Postgres data survives a restart

```
curl -s -X POST http://localhost:3000/todos -H 'Content-Type: application/json' -d '{"title":"persistence check"}'
docker compose down            # no -v, so the named volume (pgdata) is kept
docker compose up -d
curl -s http://localhost:3000/todos   # the todo created above is still there
```

### Image size: multi-stage vs. single-stage

```
docker build -t todo-api:multistage -f Dockerfile .
docker build -t todo-api:singlestage -f Dockerfile.singlestage .
docker images todo-api
```

| Image                    | Size  |
| ------------------------ | ----- |
| `todo-api:singlestage`   | 415MB |
| `todo-api:multistage`    | 356MB |

The single-stage build ships `devDependencies` (TypeScript, ts-node-dev, `@types/*`) and the
`src/` sources alongside the compiled output; the multi-stage `runner` image only ever
installs production dependencies and copies in the already-built `dist/` folder, so those
extra dev packages and source files never end up in the final layers.
