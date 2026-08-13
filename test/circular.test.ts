import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Container } from '../src/container';
import { Inject } from '../src/decorators/inject';
import { Injectable } from '../src/decorators/injectable';
import { CircularDependencyError } from '../src/errors';

const SERVICE_B = Symbol.for('SERVICE_B');
const SERVICE_Y = Symbol.for('SERVICE_Y');
const SERVICE_Z = Symbol.for('SERVICE_Z');

@Injectable()
class ServiceA {
  constructor(@Inject(SERVICE_B) readonly b: unknown) {}
}

@Injectable()
class ServiceB {
  constructor(readonly a: ServiceA) {}
}

@Injectable()
class ServiceX {
  constructor(@Inject(SERVICE_Y) readonly y: unknown) {}
}

@Injectable()
class ServiceY {
  constructor(@Inject(SERVICE_Z) readonly z: unknown) {}
}

@Injectable()
class ServiceZ {
  constructor(readonly x: ServiceX) {}
}

describe('circular dependency detection', () => {
  it('throws a named chain for A -> B -> A', () => {
    const container = new Container();
    container.register(SERVICE_B, { useClass: ServiceB });

    assert.throws(() => container.resolve(ServiceA), /ServiceA -> ServiceB -> ServiceA/);
  });

  it('throws CircularDependencyError, never a RangeError from a blown stack', () => {
    const container = new Container();
    container.register(SERVICE_B, { useClass: ServiceB });

    let caught: unknown;
    try {
      container.resolve(ServiceA);
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof CircularDependencyError, 'expected CircularDependencyError');
    assert.ok(!(caught instanceof RangeError), 'must not be a stack overflow');
    assert.deepEqual(caught.chain, ['ServiceA', 'ServiceB', 'ServiceA']);
    assert.match(caught.message, /^Circular dependency detected: /);
  });

  it('names every link of a longer chain X -> Y -> Z -> X', () => {
    const container = new Container();
    container.register(SERVICE_Y, { useClass: ServiceY });
    container.register(SERVICE_Z, { useClass: ServiceZ });

    assert.throws(
      () => container.resolve(ServiceX),
      (error: unknown) => {
        assert.ok(error instanceof CircularDependencyError);
        assert.deepEqual(error.chain, ['ServiceX', 'ServiceY', 'ServiceZ', 'ServiceX']);
        return true;
      },
    );
  });

  it('reports the cycle no matter which node the resolution starts from', () => {
    const container = new Container();
    container.register(SERVICE_B, { useClass: ServiceB });

    assert.throws(() => container.resolve(SERVICE_B), /ServiceB -> ServiceA -> ServiceB/);
  });

  it('does not mistake a diamond for a cycle', () => {
    @Injectable()
    class Leaf {}

    @Injectable()
    class Left {
      constructor(readonly leaf: Leaf) {}
    }

    @Injectable()
    class Right {
      constructor(readonly leaf: Leaf) {}
    }

    @Injectable()
    class Root {
      constructor(
        readonly left: Left,
        readonly right: Right,
      ) {}
    }

    const root = new Container().resolve(Root);

    assert.equal(root.left.leaf, root.right.leaf);
  });
});
