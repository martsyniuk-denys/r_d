import { LoggerService } from '@nestjs/common';

import { logger } from './logger';

const nest = logger.child({ layer: 'nest' });

const STACK = /\n\s+at /;

// Nest calls error(message, stack?, context?), and a Logger created with a context
// appends it: new Logger('auth').error(msg, err.stack) arrives as [stack, 'auth'].
// The last string is the context unless it is itself a stack trace; a stack
// anywhere in the parameters is kept as `stack`; an Error as the message goes to
// pino's err serializer instead of JSON.stringify, which would print {}.
function line(message: unknown, params: unknown[]): [Record<string, unknown>, string] {
  const rest = [...params];
  const fields: Record<string, unknown> = {};

  const last = rest[rest.length - 1];
  if (typeof last === 'string' && !STACK.test(last)) fields.context = rest.pop();

  const stack = rest.find((p): p is string => typeof p === 'string' && STACK.test(p));
  if (stack !== undefined) fields.stack = stack;

  if (message instanceof Error) return [{ ...fields, err: message }, message.message];
  return [fields, typeof message === 'string' ? message : JSON.stringify(message)];
}

// Nest's own lines ("Mapped {/orders, POST} route", new Logger('auth')) through the
// same pino instance, so stdout carries JSON and nothing else.
export class NestPinoLogger implements LoggerService {
  log(message: unknown, ...params: unknown[]): void {
    nest.info(...line(message, params));
  }

  error(message: unknown, ...params: unknown[]): void {
    nest.error(...line(message, params));
  }

  warn(message: unknown, ...params: unknown[]): void {
    nest.warn(...line(message, params));
  }

  debug(message: unknown, ...params: unknown[]): void {
    nest.debug(...line(message, params));
  }

  verbose(message: unknown, ...params: unknown[]): void {
    nest.trace(...line(message, params));
  }
}
