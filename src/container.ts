import 'reflect-metadata';

import { CircularDependencyError, ResolutionError } from './errors';
import {
  INJECTABLE_METADATA,
  INJECT_METADATA,
  SCOPE_METADATA,
  describeToken,
  isConstructor,
  type Constructor,
  type InjectMap,
  type Provider,
  type Scope,
  type Token,
} from './metadata';

type Registration =
  | { kind: 'class'; useClass: Constructor; scope: Scope }
  | { kind: 'value'; value: unknown };

interface Frame {
  identity: unknown;
  label: string;
}

const NON_INJECTABLE_TYPES: readonly unknown[] = [Object, Function, String, Number, Boolean, Array];

export class Container {
  private readonly registrations = new Map<Token, Registration>();
  private readonly singletons = new Map<Token, unknown>();

  register<T>(token: Token<T>, provider?: Provider<T> | Constructor<T>): this {
    this.registrations.set(token, this.normalize(token, provider));
    this.singletons.delete(token);
    return this;
  }

  has(token: Token): boolean {
    return this.registrations.has(token);
  }

  resolve<T>(token: Token<T>): T {
    return this.resolveToken(token, []) as T;
  }

  reset(): void {
    this.singletons.clear();
  }

  private normalize<T>(token: Token<T>, provider?: Provider<T> | Constructor<T>): Registration {
    if (provider === undefined) {
      if (!isConstructor(token)) {
        throw new ResolutionError(
          `Cannot register "${describeToken(token)}" without a provider: ` +
            `only a class can act as its own provider.`,
        );
      }
      return { kind: 'class', useClass: token, scope: this.scopeOf(token) };
    }

    if (isConstructor(provider)) {
      return { kind: 'class', useClass: provider, scope: this.scopeOf(provider) };
    }

    if ('useValue' in provider) {
      return { kind: 'value', value: provider.useValue };
    }

    return {
      kind: 'class',
      useClass: provider.useClass,
      scope: provider.scope ?? this.scopeOf(provider.useClass),
    };
  }

  private scopeOf(target: Constructor): Scope {
    return (Reflect.getMetadata(SCOPE_METADATA, target) as Scope | undefined) ?? 'singleton';
  }

  private resolveToken(token: Token, path: Frame[]): unknown {
    const registration = this.registrationFor(token, path);

    if (registration.kind === 'value') {
      return registration.value;
    }

    const { useClass, scope } = registration;
    const frame: Frame = { identity: useClass, label: useClass.name };

    if (path.some((step) => step.identity === frame.identity)) {
      throw new CircularDependencyError([...path, frame].map((step) => step.label));
    }

    if (scope === 'singleton' && this.singletons.has(token)) {
      return this.singletons.get(token);
    }

    const instance = this.instantiate(useClass, [...path, frame]);

    if (scope === 'singleton') {
      this.singletons.set(token, instance);
    }

    return instance;
  }

  private registrationFor(token: Token, path: Frame[]): Registration {
    const registered = this.registrations.get(token);
    if (registered) return registered;

    if (isConstructor(token)) {
      return { kind: 'class', useClass: token, scope: this.scopeOf(token) };
    }

    throw new ResolutionError(
      `No provider registered for token "${describeToken(token)}"${formatPath(path)}. ` +
        `Register it with container.register(token, { useValue }) or { useClass }.`,
    );
  }

  private instantiate(target: Constructor, path: Frame[]): unknown {
    if (!Reflect.getMetadata(INJECTABLE_METADATA, target)) {
      throw new ResolutionError(
        `${target.name} is not decorated with @Injectable()${formatPath(path)}. ` +
          `Without a decorator TypeScript emits no design:paramtypes for the class, ` +
          `so the container cannot know what its constructor needs.`,
      );
    }

    const paramTypes =
      (Reflect.getMetadata('design:paramtypes', target) as unknown[] | undefined) ?? [];
    const injected = (Reflect.getOwnMetadata(INJECT_METADATA, target) as InjectMap | undefined) ?? {};

    const dependencies = paramTypes.map((paramType, index) => {
      const token = injected[index] ?? (paramType as Token | undefined);
      this.assertResolvable(token, target, index, injected[index] !== undefined);
      return this.resolveToken(token as Token, path);
    });

    return new target(...dependencies);
  }

  private assertResolvable(
    token: Token | undefined,
    target: Constructor,
    index: number,
    explicit: boolean,
  ): void {
    if (explicit) return;

    const where = `parameter #${index} of ${target.name}`;

    if (token === undefined) {
      throw new ResolutionError(
        `Cannot resolve ${where}: its type is undefined at runtime. ` +
          `This usually means a circular import between modules — use @Inject(token) instead.`,
      );
    }

    if (NON_INJECTABLE_TYPES.includes(token)) {
      throw new ResolutionError(
        `Cannot resolve ${where}: the emitted type is "${describeToken(token)}". ` +
          `Interfaces and primitives are erased at runtime, so they cannot be used as tokens — ` +
          `annotate the parameter with @Inject(token).`,
      );
    }
  }
}

function formatPath(path: Frame[]): string {
  return path.length > 0 ? ` (while resolving ${path.map((step) => step.label).join(' -> ')})` : '';
}
