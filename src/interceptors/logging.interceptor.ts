import { getRequestId } from '../context/request-context';
import type { CallHandler, ExecutionContext, Interceptor } from '../lifecycle';

export type LogSink = (message: string) => void;

export class LoggingInterceptor implements Interceptor {
  private readonly log: LogSink;

  constructor(log: LogSink = (message) => console.log(message)) {
    this.log = log;
  }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<unknown> {
    const startedAt = performance.now();

    try {
      return await next();
    } finally {
      const duration = (performance.now() - startedAt).toFixed(1);

      this.log(`[${getRequestId() ?? '-'}] ${context.method} ${context.path} — ${duration} ms`);
    }
  }
}
