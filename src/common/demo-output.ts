// The key=value report, the invariant checks and the exit-code convention every
// demo shares. It imports nothing that reads the environment, so a demo that needs
// only Redis does not have to have a database configured just to print its lines.

export class Invariants {
  private readonly failures: string[] = [];

  check(label: string, ok: boolean, detail: string): void {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}: ${detail}`);
    if (!ok) this.failures.push(label);
  }

  get broken(): number {
    return this.failures.length;
  }
}

export function report(values: Record<string, number | string>): void {
  for (const [key, value] of Object.entries(values)) console.log(`${key}=${value}`);
}

export function runDemo(main: () => Promise<number>): void {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}

export const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
