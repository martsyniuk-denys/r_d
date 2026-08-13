import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Container } from '../src/container';
import { Inject } from '../src/decorators/inject';
import { Injectable } from '../src/decorators/injectable';
import { ResolutionError } from '../src/errors';
import { INJECT_METADATA } from '../src/metadata';
import { CONFIG_TOKEN, LOGGER_TOKEN, type AppConfig, type Logger } from '../src/tokens';

@Injectable()
class Clock {
  now(): string {
    return 'now';
  }
}

@Injectable()
class ConfigConsumer {
  constructor(@Inject(CONFIG_TOKEN) readonly config: AppConfig) {}
}

@Injectable()
class Reporter {
  constructor(
    readonly clock: Clock,
    @Inject(LOGGER_TOKEN) readonly logger: Logger,
    @Inject(CONFIG_TOKEN) readonly config: AppConfig,
  ) {}
}

interface Mailer {
  send(to: string): void;
}

@Injectable()
class Notifier {
  constructor(readonly mailer: Mailer) {}
}

const CLOCK_TOKEN = Symbol.for('CLOCK');

@Injectable()
class TokenBeatsType {
  constructor(@Inject(CLOCK_TOKEN) readonly clock: Clock) {}
}

function makeContainer(): Container {
  const container = new Container();
  container.register(CONFIG_TOKEN, { useValue: { appName: 'ioc', port: 3000 } satisfies AppConfig });
  container.register(LOGGER_TOKEN, { useValue: { log: () => undefined } satisfies Logger });
  return container;
}

describe('@Inject(token)', () => {
  it('resolves a dependency registered under Symbol.for("CONFIG") by token', () => {
    const container = makeContainer();

    const consumer = container.resolve(ConfigConsumer);

    assert.equal(consumer.config.appName, 'ioc');
    assert.equal(consumer.config.port, 3000);
    assert.equal(consumer.config, container.resolve(CONFIG_TOKEN));
  });

  it('mixes type-based and token-based parameters in one constructor', () => {
    const container = makeContainer();

    const reporter = container.resolve(Reporter);

    assert.ok(reporter.clock instanceof Clock, 'the typed parameter still comes from paramtypes');
    assert.equal(typeof reporter.logger.log, 'function');
    assert.equal(reporter.config.appName, 'ioc');
  });

  it('prefers the token over the emitted constructor type', () => {
    const container = makeContainer();
    const stub: Clock = { now: () => 'stubbed' };
    container.register(CLOCK_TOKEN, { useValue: stub });

    assert.equal(container.resolve(TokenBeatsType).clock, stub);
    assert.notEqual(container.resolve(TokenBeatsType).clock, container.resolve(Clock));
  });

  it('explains that an interface parameter needs a token', () => {
    const container = makeContainer();

    assert.throws(
      () => container.resolve(Notifier),
      (error: unknown) => {
        assert.ok(error instanceof ResolutionError);
        assert.match(error.message, /parameter #0 of Notifier/);
        assert.match(error.message, /erased at runtime/);
        assert.match(error.message, /@Inject\(token\)/);
        return true;
      },
    );
  });

  it('stores the tokens as an index -> token map, alongside the erased paramtypes', () => {
    assert.deepEqual(Reflect.getMetadata('design:paramtypes', Reporter), [Clock, Object, Object]);

    assert.deepEqual(Reflect.getOwnMetadata(INJECT_METADATA, Reporter), {
      1: LOGGER_TOKEN,
      2: CONFIG_TOKEN,
    });
  });
});
