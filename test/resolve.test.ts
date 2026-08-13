import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Container } from '../src/container';
import { Injectable } from '../src/decorators/injectable';
import { ResolutionError } from '../src/errors';

@Injectable()
class Engine {
  start(): string {
    return 'vroom';
  }
}

@Injectable()
class Gearbox {
  constructor(readonly engine: Engine) {}
}

@Injectable()
class Car {
  constructor(readonly gearbox: Gearbox) {}

  drive(): string {
    return this.gearbox.engine.start();
  }
}

class PlainService {
  constructor(readonly engine: Engine) {}
}

@Injectable()
class Garage {
  constructor(readonly plain: PlainService) {}
}

describe('recursive resolution', () => {
  it('builds a three-level graph (Car -> Gearbox -> Engine) from metadata alone', () => {
    const container = new Container();

    const car = container.resolve(Car);

    assert.ok(car instanceof Car);
    assert.ok(car.gearbox instanceof Gearbox, 'Gearbox must be constructed, not undefined');
    assert.ok(car.gearbox.engine instanceof Engine, 'Engine must be alive inside the Gearbox');
    assert.equal(car.drive(), 'vroom', 'the deepest dependency must be a working object');
  });

  it('reads the constructor types from design:paramtypes', () => {
    const paramTypes = Reflect.getMetadata('design:paramtypes', Car);

    assert.deepEqual(paramTypes, [Gearbox], 'TypeScript must have emitted the parameter types');
  });

  it('resolves a class that has no dependencies at all', () => {
    const container = new Container();

    assert.equal(container.resolve(Engine).start(), 'vroom');
  });

  it('refuses to build a class that is not decorated with @Injectable()', () => {
    const container = new Container();

    assert.throws(
      () => container.resolve(PlainService),
      (error: unknown) => {
        assert.ok(error instanceof ResolutionError);
        assert.match(error.message, /PlainService is not decorated with @Injectable\(\)/);
        assert.match(error.message, /design:paramtypes/);
        return true;
      },
    );
  });

  it('names the resolution path when a nested dependency cannot be built', () => {
    const container = new Container();

    assert.throws(
      () => container.resolve(Garage),
      /PlainService is not decorated with @Injectable\(\).*while resolving Garage -> PlainService/s,
    );
  });

  it('throws a readable error for an unknown token', () => {
    const container = new Container();

    assert.throws(
      () => container.resolve(Symbol.for('NOPE')),
      /No provider registered for token "NOPE"/,
    );
  });
});
