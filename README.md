# IoC container from scratch

A dependency-injection container built the way NestJS builds one: it reads the constructor
parameter types that TypeScript stores in metadata and assembles the object graph itself.
No `@nestjs/*`, no `inversify`, no `tsyringe`, no `typedi` — the only runtime dependency is
`reflect-metadata`.

Part 1 of 3 (lecture 6). Controllers and DTOs come in part 2, pipes/guards/interceptors/filters
in part 3.

## What it does

| Feature | Where |
| --- | --- |
| `@Injectable({ scope })` — marks a class as constructible | `src/decorators/injectable.ts` |
| `@Inject(token)` — explicit token for one constructor parameter | `src/decorators/inject.ts` |
| resolution through `design:paramtypes`, recursive graph building | `src/container.ts` |
| `singleton` (default) and `transient` scopes | `src/container.ts` |
| cycle detection with the full chain in the message | `src/container.ts`, `src/errors.ts` |
| injection tokens (`Symbol.for('CONFIG')`, ...) | `src/tokens.ts` |
| tests | `test/` |

## Run it

```
npm install
npm test     # tsc + node:test — 22 tests
npm start    # small demo: resolves a graph and prints it
npm run build
```

Requires Node 18+ (the test runner is `node:test`, no extra dev dependency).
TypeScript is pinned to 6.x (`typescript@6` → 6.0.3).

## Docker

Reuses the image approach from homework #5 — multi-stage `node:22-slim`, `npm ci`, a builder
stage with dev dependencies and a slim production runner.

```
docker compose run --rm api npm test        # the suite, inside the image
docker compose run --rm demo                # the demo, from the production-only stage
```

The `api` service builds the **builder** target on purpose: it is the stage that holds
TypeScript and `test/`. The `runner` target ships production dependencies plus `dist/` only,
and runs as the non-root `node` user.

## Usage

```ts
import 'reflect-metadata';
import { Container, Inject, Injectable, CONFIG_TOKEN, type AppConfig } from './src';

@Injectable()
class Database {}

@Injectable({ scope: 'transient' })
class RequestId {}

@Injectable()
class UserService {
  constructor(
    private readonly db: Database,                        // resolved by type
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig, // resolved by token
  ) {}
}

const container = new Container();
container.register(CONFIG_TOKEN, { useValue: { appName: 'demo', port: 3000 } });

container.resolve(UserService); // Database is constructed and injected automatically
```

Providers: `register(token, { useClass, scope? })`, `register(token, { useValue })`, or the
shorthand `register(SomeClass)`. A decorated class does not need registering at all — it acts
as its own token.

## How it works

The whole thing rests on one compiler feature. With `"emitDecoratorMetadata": true` (and
`"experimentalDecorators": true`, which it requires), TypeScript emits an extra
`Reflect.metadata('design:paramtypes', [...])` call next to every **decorated** class — an array
of the constructor parameter *types as runtime values*. `@Injectable()` itself does almost
nothing: two `Reflect.defineMetadata` calls, one marking the class as injectable and one storing
its scope. Its real job is to be a decorator at all, because that is the trigger for the compiler
to emit `design:paramtypes` — a class with no decorator gets no metadata whatsoever, even with
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
get the metadata this homework is about.

| File | Covers |
| --- | --- |
| `test/resolve.test.ts` | three-level graph `Car -> Gearbox -> Engine`, `design:paramtypes` contents, undecorated class, unknown token, path in error messages |
| `test/scopes.test.ts` | singleton identity, shared dependencies, transient, per-container caches, provider-level scope override |
| `test/inject.test.ts` | `Symbol.for('CONFIG')` by token, mixed type/token constructors, token beating the type, interface without a token |
| `test/circular.test.ts` | `A -> B -> A`, `X -> Y -> Z -> X`, `CircularDependencyError` (never `RangeError`), diamond graphs are not cycles |
