# mini-nest

A small NestJS clone built from scratch: an IoC container that reads constructor types from
metadata, plus decorator-based routing and DTO validation on top of `node:http`.
No `@nestjs/*`, no `express`, no `fastify`, no `inversify`/`tsyringe`/`typedi` — the routing,
the container and the dispatcher are all here.

- **Part 1 (lecture 6, `feature/homework_6`)** — the IoC container: `@Injectable`, `@Inject`,
  scopes, cycle detection.
- **Part 2 (lecture 7, `feature/homework_7`)** — this branch: `@Controller`, `@Get`/`@Post`,
  `@Body`/`@Param`/`@Query`, the HTTP dispatcher and the validation pipe. It continues part 1;
  branches keep the `feature/homework_N` naming used by the rest of this repository instead of
  `part-1-ioc` / `part-2-http`.
- **Part 3 (lecture 8)** — pipes, guards, interceptors, filters.

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
| `node:http` server, argument assembly, JSON serialisation, error mapping | `src/dispatcher.ts` |
| DTO validation (`plainToInstance` + `validate`) | `src/pipes/validation.pipe.ts` |
| the DTO itself | `src/dto/create-user.dto.ts` |
| demo controller/service wired through the container | `src/controllers/`, `src/services/` |
| tests | `test/` |

## Run it

```
npm install
npm test     # tsc + node:test — 41 tests
npm start    # starts the HTTP server on http://localhost:3000
npm run build
```

Requires Node 18+ (`node:test` and global `fetch`, no extra dev dependency).
TypeScript is pinned to 6.x (`typescript@6` → 6.0.3).

### Endpoints of the demo app

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | controller with an empty prefix |
| GET | `/users` | `@Query('limit') limit?: number` |
| GET | `/users/:id` | `@Param('id') id: number` |
| POST | `/users` | `@Body() dto: CreateUserDto`, 201 on success, 400 on invalid input |

```
curl localhost:3000/users/42
curl "localhost:3000/users?limit=1"
curl -X POST localhost:3000/users -H 'content-type: application/json' \
     -d '{"name":"Alan Turing","email":"alan@example.com","age":41}'
curl -X POST localhost:3000/users -H 'content-type: application/json' \
     -d '{"email":"not-an-email"}'
# {"statusCode":400,"message":"Validation failed","errors":[{"field":"name",...},{"field":"email",...}]}
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
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }
}

const container = new Container();
const router = new Router().register(UsersController);
await new Dispatcher(container, router).listen(3000);
```

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
number` arrive as a number instead of the string `'42'`, and what tells the validation pipe which
DTO class to build. The order of execution — parameters first, then the method decorator, then the
class decorator — never matters here, because nothing is read during decoration: the router
collects all three layers later, in `Router.register()`. There is a test pinning that order anyway.

### Validation

`@Body() dto: CreateUserDto` hands the pipe two things: the parsed JSON and `CreateUserDto` from
`design:paramtypes`. `class-validator` only inspects class instances — a plain object carries no
decorator metadata of its own — so the pipe first does `plainToInstance(CreateUserDto, body)` and
only then `validate(instance)`; skipping the first step makes the validator silently pass
everything. Failures are collected into `[{ field, constraints }]` for *every* offending field and
returned as `400` with the full list; on success the handler receives the DTO instance itself,
which `test/http.test.ts` asserts with `instanceof CreateUserDto`.

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

`npm test` compiles with real `tsc` and runs `node --test` over `dist/test`. Compiling first is
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
| `test/http.test.ts` | `GET /users/42`, `?limit=`, type coercion, `POST` 201, DTO instance in the handler, 400 with every failing field, malformed JSON, 404, controller and service resolved through the container |
