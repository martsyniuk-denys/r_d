# mini-nest

A small NestJS clone built from scratch: an IoC container that reads constructor types from
metadata, decorator-based routing on top of `node:http`, and the full request lifecycle —
middleware, guard, interceptor, pipe, exception filter — with a per-request context carried by
`AsyncLocalStorage`. No `@nestjs/*`, no `express`, no `fastify`, no `inversify`/`tsyringe`/`typedi`.

- **Part 1 (lecture 6, `feature/homework_6`)** — the IoC container: `@Injectable`, `@Inject`,
  scopes, cycle detection.
- **Part 2 (lecture 7, `feature/homework_7`)** — `@Controller`, `@Get`/`@Post`,
  `@Body`/`@Param`/`@Query`, the HTTP dispatcher and DTO validation.
- **Part 3 (lecture 8, `feature/homework_8`)** — this branch: the request lifecycle
  (`AuthGuard`, `LoggingInterceptor`, `ZodValidationPipe`, `HttpExceptionFilter`), request-scoped
  context on `AsyncLocalStorage`, and a test that pins the order of the six stages.
  Branches keep the `feature/homework_N` naming used by the rest of this repository instead of
  `part-1-ioc` / `part-2-http` / `part-3-lifecycle`.

## What it does

| Feature | Where |
| --- | --- |
| `@Injectable({ scope })` — marks a class as constructible | `src/decorators/injectable.ts` |
| `@Inject(token)` — explicit token for one constructor parameter | `src/decorators/inject.ts` |
| resolution through `design:paramtypes`, recursive graph building, scopes, cycle detection | `src/container.ts` |
| `@Controller(prefix)` — base path of a controller | `src/decorators/controller.ts` |
| `@Get(path)` / `@Post(path)` — route registration | `src/decorators/methods.ts` |
| `@Body()`, `@Param(name)`, `@Query(name)` — argument sources | `src/decorators/params.ts` |
| route table built from metadata, `:param` matching | `src/router.ts` |
| `node:http` server, the lifecycle chain, argument assembly, JSON serialisation | `src/dispatcher.ts` |
| the contracts each stage implements (`CanActivate`, `Interceptor`, `PipeTransform`, …) | `src/lifecycle.ts` |
| `@UseGuards` / `@UseInterceptors`, on a controller or a single handler | `src/decorators/use.ts` |
| request id + the `AsyncLocalStorage` scope every later stage runs inside | `src/middleware/request-id.middleware.ts` |
| the `AsyncLocalStorage` wrapper itself | `src/context/request-context.ts` |
| `AuthGuard` — `Authorization: Bearer …` or 403 | `src/guards/auth.guard.ts` |
| `LoggingInterceptor` — `[id] GET /users/1 — 12.3 ms` | `src/interceptors/logging.interceptor.ts` |
| `ZodValidationPipe` — Zod 4 schema per argument | `src/pipes/zod-validation.pipe.ts` |
| `HttpExceptionFilter` — 404 / 400 / 500 mapping | `src/filters/exception.filter.ts` |
| the DTO, which is now a Zod schema | `src/dto/create-user.dto.ts` |
| demo controllers/services wired through the container | `src/controllers/`, `src/services/` |
| tests | `test/` |

## Run it

```
npm install
npm test     # tsc + node:test — 78 tests
npm start    # starts the HTTP server on http://localhost:3000
npm run build
```

Requires Node 18+ (`node:test` and global `fetch`, no extra dev dependency).
TypeScript is pinned to 6.x (`typescript@6` → 6.0.3).

### Endpoints of the demo app

| Method | Path | Guard | Notes |
| --- | --- | --- | --- |
| GET | `/health` | — | controller with an empty prefix, open on purpose |
| GET | `/context` | — | the request id read two calls below the handler |
| GET | `/users` | `AuthGuard` | `@Query('limit') limit?: number` |
| GET | `/users/:id` | `AuthGuard` | `@Param('id') id: number`, 404 for an unknown id |
| POST | `/users` | `AuthGuard` | `@Body(createUserSchema)`, 201 on success, 400 on invalid input |

Every response carries `X-Request-Id`; send your own and it is echoed back.

```
curl -si localhost:3000/users/1 | grep -i x-request-id
# x-request-id: 740e28f1-ef03-435c-85fc-91509c2fa92d

curl -i localhost:3000/users/1
# HTTP/1.1 403 Forbidden    <- the guard, before anything was parsed

curl -H 'Authorization: Bearer token' localhost:3000/users/999
# {"statusCode":404,"message":"User 999 not found","requestId":"f64ebb3f-..."}

curl -X POST localhost:3000/users -H 'Authorization: Bearer token' \
     -H 'content-type: application/json' -d '{"name":"x","email":"nope"}'
# {"statusCode":400,"message":"Validation failed","requestId":"2ff7fca2-...",
#  "errors":[{"field":"name","constraints":["name must be at least 2 characters"]},
#            {"field":"email","constraints":["email must be a valid email address"]}]}

curl -H 'X-Request-Id: deep-trace' localhost:3000/context
# {"requestId":"deep-trace","seenBy":"AuditService","users":2}
```

The server logs one line per request, written by the interceptor:

```
[740e28f1-ef03-435c-85fc-91509c2fa92d] GET /users/1 — 0.3 ms
[deep-trace] GET /context — 2.5 ms
```

## Docker

Multi-stage `node:22-slim` image, same approach as homework #5.

```
docker compose run --rm api npm test        # the suite, inside the image
docker compose up demo                      # the server on http://localhost:3000
```

The `api` service builds the **builder** target on purpose: it is the stage that holds
TypeScript and `test/`. The `runner` target ships production dependencies plus `dist/` only,
runs as the non-root `node` user and has a healthcheck against `/health`.

## Usage

```ts
@Injectable()
class UsersService {
  findOne(id: number) { ... }
}

@Controller('users')
class UsersController {
  constructor(readonly users: UsersService) {}

  @Get(':id')
  findOne(@Param('id') id: number) {
    return this.users.findOne(id);
  }

  @Post()
  create(@Body(createUserSchema) dto: CreateUserDto) {
    return this.users.create(dto);
  }
}

const container = new Container();
const router = new Router().register(UsersController);

await new Dispatcher(container, router, {
  middleware: [new RequestIdMiddleware()],   // opens the AsyncLocalStorage scope
  interceptors: [new LoggingInterceptor()],  // global: wraps every handler
  pipes: [new ZodValidationPipe()],          // global: runs on every argument
  filter: new HttpExceptionFilter(),         // last: turns throws into responses
}).listen(3000);
```

A stage can be given as a class (built by the container, so it can have dependencies) or as a
ready-made instance (`new LoggingInterceptor(myLogger)`). `@UseGuards` and `@UseInterceptors`
work on a controller — every route below it — or on a single handler; the two lists are
concatenated, class first.

## The request lifecycle

```
                         ┌──────────────────────────────────────────────────┐
   incoming request      │  try {                          Dispatcher.handle│
          │              │                                                  │
          ▼              │   ┌────────────┐                                 │
  ┌───────────────┐      │   │ MIDDLEWARE │  request id -> header + ALS     │
  │ createContext │──────┼──▶│            │  wraps everything below         │
  │  method, path │      │   └─────┬──────┘                                 │
  │  requestId    │      │         ▼                                        │
  └───────────────┘      │   ┌────────────┐  route matched                  │
                         │   │   GUARD    │  false ──────────────┐          │
                         │   │  boolean   │                      │          │
                         │   └─────┬──────┘                      │          │
                         │         ▼                             │          │
                         │   ┌────────────────────────────┐      │          │
                         │   │ INTERCEPTOR (before)       │      │          │
                         │   │  t0 = performance.now()    │      │          │
                         │   │   ┌──────────────────────┐ │      │          │
                         │   │   │ PIPE  (per argument) │ │      │          │
                         │   │   │  zod safeParse       │─┼──────┤ throw    │
                         │   │   └──────────┬───────────┘ │      │          │
                         │   │              ▼             │      │          │
                         │   │   ┌──────────────────────┐ │      │          │
                         │   │   │      HANDLER         │─┼──────┤ throw    │
                         │   │   │  service -> service  │ │      │          │
                         │   │   └──────────┬───────────┘ │      │          │
                         │   │              ▼             │      │          │
                         │   │ INTERCEPTOR (after)        │      │          │
                         │   │  log "GET /users/1 — 2 ms" │      │          │
                         │   └──────────────┬─────────────┘      │          │
                         │                  ▼                    ▼          │
                         │            200 / 201 JSON   } catch { FILTER }   │
                         └──────────────────────────────────────────────────┘
                                            │                    │
                                            ▼                    ▼
                                     response + X-Request-Id   404 / 400 / 403 / 500
```

Two properties are load-bearing, and both are pinned by `test/lifecycle-order.test.ts`:

- The **filter wraps the whole thing**, not just the handler. `Dispatcher.handle` is one
  `try`/`catch` around the middleware chain, so a throw from a *middleware* or an *interceptor*
  lands there too — the test proves it for both.
- Everything after the middleware runs **inside** `RequestContext.run`, because `next()` is
  awaited within it.

### Guard vs. interceptor, in one sentence each

A **guard** answers one question — let this request through? — before anything is parsed or
validated, and its whole vocabulary is `true`/`false`: it cannot see the result and cannot change
the response, a `false` simply becomes 403. An **interceptor** wraps the handler call, so it sees
both sides — code before `next()`, the returned value after it — which is why measuring duration
or wrapping a payload in `{ data: … }` belongs there and cannot be done in a guard.

The consequence is visible in the demo: a 403 never reaches the log, because the guard runs
*before* the interceptor's timer starts. That is the same ordering NestJS uses.

### The stages, one by one

| Stage | Contract | Returns | Where |
| --- | --- | --- | --- |
| Middleware | `use(ctx, next)` | nothing; wraps `next()` | `src/middleware/request-id.middleware.ts` |
| Guard | `canActivate(ctx)` | `boolean` — `false` → 403 | `src/guards/auth.guard.ts` |
| Interceptor | `intercept(ctx, next)` | the (possibly replaced) result | `src/interceptors/logging.interceptor.ts` |
| Pipe | `transform(value, metadata)` | the value the handler receives | `src/pipes/zod-validation.pipe.ts` |
| Handler | your method | anything JSON-serialisable | `src/controllers/` |
| Filter | `catch(error, ctx)` | writes the response itself | `src/filters/exception.filter.ts` |

The filter's mapping is the only place statuses are decided:

| Thrown | Response |
| --- | --- |
| `NotFoundError('User 999 not found')` | `404 {"statusCode":404,"message":"User 999 not found","requestId":…}` |
| `ValidationError([...])` | `400` with `errors: [{ field, constraints }]` |
| `HttpError(418, …)` | that status, that message |
| `new Error('boom')` | `500 {"message":"Internal server error"}` — logged in full server-side, no message and no stack on the wire |

## Why `AsyncLocalStorage` and not a global variable

The request id has to be readable by a logger three calls below the handler without appearing in a
single signature in between — so the obvious first idea is a module-level `let currentRequestId`.
It works exactly until the second concurrent request, and this is not a race that shows up under
load testing only: it shows up the first time two requests overlap at all. Node is single-threaded
but not single-request. The moment a handler hits an `await` — a query, a `fetch`, a timer — the
event loop is free, picks up the next connection, and that request's middleware assigns the global.
When the first handler resumes and finally logs, it reads the *second* request's id. Nothing
throws, nothing looks broken; the ids in the log are simply attributed to the wrong requests, which
is the worst possible failure mode for a trace id. Locking is not an option either, because there
is nothing to lock: the two requests are interleaved on the same thread, not racing on two.

`AsyncLocalStorage` fixes this by binding the value to the *async execution branch* rather than to
the process. `RequestContext.run(store, next)` in the middleware opens a scope; Node's async hooks
propagate it across every `await`, `.then`, timer and callback spawned inside it, so each request
carries its own store down its own branch and `getRequestId()` reads whichever store belongs to the
branch it is called from. `AuditService` is a plain singleton shared by all ten concurrent requests
in `test/request-context.test.ts` and still records ten distinct ids, because the state is in the
scope, not in the service.

Two rules follow, and both are easy to get wrong:

- `run()` must wrap the **entire** request handler, not just part of it. If the ALS scope opened
  after the body was read, or closed before the response was written, the code outside it would
  read `undefined`. That is why the request-id middleware is first in the chain and awaits `next()`
  from inside `run()` — the guard, the interceptor, the pipe, the handler and every service below
  them are all inside that one scope.
- Code that runs *outside* a request — a startup task, a test calling a service directly — gets
  `undefined`, and must handle it rather than assume an id exists.

The exception filter is the one deliberate exception: it runs in the `catch` outside the chain, so
it reads the id from the `ExecutionContext` object instead of from the store.

## How it works

The whole thing rests on one compiler feature. With `"emitDecoratorMetadata": true` (and
`"experimentalDecorators": true`, which it requires), TypeScript emits an extra
`Reflect.metadata('design:paramtypes', [...])` call next to every **decorated** class and method —
an array of the parameter types as runtime values. `@Injectable()` itself does almost nothing: two
`Reflect.defineMetadata` calls, one marking the class as injectable and one storing its scope. Its
real job is to be a decorator at all, because that is the trigger for the compiler to emit
`design:paramtypes` — a class with no decorator gets no metadata whatsoever, even with
`emitDecoratorMetadata` on. The container then does the obvious thing: on `resolve(X)` it reads
`Reflect.getMetadata('design:paramtypes', X)`, resolves each entry the same way (recursively,
depth-first), and calls `new X(...deps)`. Turn `emitDecoratorMetadata` off and that array is
simply never written — `getMetadata` returns `undefined`, the container sees a constructor with
no dependencies, and every class with arguments is built with `undefined` in place of them.
That is why the flag is not optional: it *is* the source of the dependency graph.

Type erasure sets the boundary of what the flag can give you. An interface has no runtime
representation, so a parameter typed with one is emitted as `Object`; primitives collapse to
`String`/`Number`/`Boolean` and identify nothing. `@Inject(token)` is the escape hatch: it stores
an `index -> token` map on the class, and the container prefers that token over the emitted type
for that parameter. The container rejects a bare `Object` parameter with an explicit message
rather than injecting nonsense.

Scope is read from the same metadata: `singleton` (the default) caches the instance per token per
container, `transient` skips the cache entirely. Cycles are caught by threading the resolution
path through the recursion — every step pushes the class being built, and re-entering a class
that is already on the path throws `CircularDependencyError` with the whole chain
(`ServiceA -> ServiceB -> ServiceA`) instead of letting the recursion die with
`RangeError: Maximum call stack size exceeded`. Detection is keyed on the class, not on the
token, so a cycle is still reported when a link is registered under a symbol.

### How a parameter decorator knows where to put the value

A parameter decorator cannot read anything from the request: it runs once, at class-definition
time, long before any request exists. What it *does* receive is
`(target, propertyKey, parameterIndex)` — and that index is the whole trick. `@Param('id')` stores
`{ 0: { source: 'param', name: 'id' } }` under a symbol key attached to the prototype **and** the
method name (`Reflect.defineMetadata(PARAMS_METADATA, map, prototype, 'findOne')`), so every
handler keeps its own map and repeated decorators merge into it by index. It writes down *where
the value should come from*, nothing more. At request time the dispatcher walks that map: for each
index it takes the matched route parameters, the `URLSearchParams`, or the parsed body, puts the
value at exactly that position of an argument array, and calls
`handler.apply(controller, args)` — so the handler receives plain arguments and never touches
`req`. The type sitting next to the parameter comes from the same
`design:paramtypes` array, read for the *method* this time, which is what lets `@Param('id') id:
number` arrive as a number instead of the string `'42'`. A Zod schema cannot come from there — a
`type` alias leaves nothing behind at runtime — so `@Body(schema)` writes it into the same map,
next to the source. The order of execution — parameters first, then the method decorator, then the
class decorator — never matters here, because nothing is read during decoration: the router
collects all three layers later, in `Router.register()`. There is a test pinning that order anyway.

### Validation, rewritten on Zod 4

Part 2 validated with `class-validator`: the DTO was a class, the pipe did
`plainToInstance(CreateUserDto, body)` and then `validate(instance)`, and the schema lived in
property decorators. On Zod the DTO *is* the schema and the class disappears:

```ts
export const createUserSchema = z.object({
  name: z.string().min(2, 'name must be at least 2 characters').max(50),
  email: z.email('email must be a valid email address'),
  age: z.int().min(0).max(150).optional(),
}).strict();

export type CreateUserDto = z.infer<typeof createUserSchema>;
```

The type is *derived* from the schema, so the two cannot drift apart. That costs one thing: a
`type` alias is erased at runtime, so `design:paramtypes` reports the parameter as `Object` and the
pipe can no longer find the schema through the emitted metatype the way it found `CreateUserDto`.
Hence `@Body(createUserSchema)` — the decorator stores the schema next to the argument's source in
the same `PARAMS_METADATA` map, and the pipe reads it from `ArgumentMetadata`. An argument with no
schema passes through untouched, which is what makes `@Param('id')` and `@Query('limit')` still
work through the same pipe.

The pipe returns `result.data`, not the input: defaults are applied and, because the schema is
`.strict()`, an unknown key like `isAdmin` is a 400 rather than something the handler quietly
receives.

Two Zod 4 details worth writing down, because most examples online are Zod 3:

- errors are in **`error.issues`**, not `error.errors`;
- top-level string formats moved out of the `z.string()` chain — it is `z.email()`, not
  `z.string().email()`, and `z.int()` rather than `z.number().int()`.

Several issues can land on the same field (`'too short'` *and* `'must start with a'`), so
`toFieldErrors` groups them by `issue.path.join('.')` and the client gets one row per field with
every reason on it — the same `[{ field, constraints }]` shape part 2 produced.

### Why the cycle test uses a token

Two classes referring to each other *by type* in one file cannot be compiled into a working
runtime cycle: decorators execute at class-definition time, so the class declared second is still
in its temporal dead zone when the first one's metadata is emitted. Split across two modules, the
circular `require` resolves to `undefined` and the type is erased to `Object` instead. Both are
TypeScript emit limitations, not container limitations — Nest works around them with
`forwardRef()`. A token has no such problem because it is looked up lazily at resolve time, so
`test/circular.test.ts` wires `ServiceA -> ServiceB -> ServiceA` through `Symbol.for('SERVICE_B')`.
The cycle it exercises is a real one; only the wiring is explicit.

## Tests

`npm test` compiles with real `tsc` and runs `node --test` over `dist/test` — 78 tests. Compiling first is
deliberate: `emitDecoratorMetadata` is a TypeScript feature, and the esbuild-based runners
(vitest out of the box) do **not** emit it — using them would mean adding an SWC plugin just to
get the metadata this homework is about. The HTTP tests start the real dispatcher on an ephemeral
port and talk to it with the built-in `fetch`.

| File | Covers |
| --- | --- |
| `test/resolve.test.ts` | three-level graph `Car -> Gearbox -> Engine`, `design:paramtypes` contents, undecorated class, unknown token, path in error messages |
| `test/scopes.test.ts` | singleton identity, shared dependencies, transient, per-container caches, provider-level scope override |
| `test/inject.test.ts` | `Symbol.for('CONFIG')` by token, mixed type/token constructors, token beating the type, interface without a token |
| `test/circular.test.ts` | `A -> B -> A`, `X -> Y -> Z -> X`, `CircularDependencyError` (never `RangeError`), diamond graphs are not cycles |
| `test/router.test.ts` | routes read from metadata, prefix joining, `:param` extraction, static-before-dynamic, empty prefix, decorator execution order, missing `@Controller()` |
| `test/http.test.ts` | `GET /users/42`, `?limit=`, type coercion, `POST` 201, the parsed value in the handler, 400 with every failing field, malformed JSON, 404, controller and service resolved through the container |
| `test/lifecycle-order.test.ts` | the six labels in exactly one order, the filter running last after a throw, a 404 that skips straight from middleware to filter |
| `test/guard.test.ts` | 403 without `Authorization` **and a spy proving the handler never ran**, malformed header, class + method guards, an unguarded route, a guard beating the pipe to an invalid body |
| `test/interceptor.test.ts` | the log line matches `GET /slow … 12.3 ms`, the duration is real (≥ 15 ms), the id comes from the store, a throwing handler is still timed, an interceptor replacing the result |
| `test/pipe.test.ts` | valid body parsed, 400 listing every field, missing field, unknown key rejected, no-schema passthrough, several issues grouped onto one field, `@Param` coercion untouched |
| `test/filter.test.ts` | `NotFoundError` → 404, `ValidationError` → 400 with fields, `new Error('boom')` → 500 with no `boom` and no stack, a throw from an interceptor and from a middleware, the request id on error responses |
| `test/request-context.test.ts` | id survives an `await`, two interleaved scopes stay apart, header echoed or generated, a service two levels down reads the same id, **10 concurrent requests with no cross-talk** |
