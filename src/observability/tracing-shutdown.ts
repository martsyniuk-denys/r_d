// The flush hook, kept apart from tracing.ts: importing tracing.ts starts the SDK,
// and AppModule is also loaded by the test suites, which must not start one.
// Until tracing.ts registers itself, shutting tracing down is a no-op.
let flush: () => Promise<void> = () => Promise.resolve();

export function onTracingShutdown(fn: () => Promise<void>): void {
  flush = fn;
}

export function shutdownTracing(): Promise<void> {
  return flush();
}
