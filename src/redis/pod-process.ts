import { ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

// A dist/pod.js child process: started, waited on until it listens, stopped or
// killed. Pods hold no state, so a demo can run two of them side by side or kill
// one and start another, and see what survives.

const live = new Set<ChildProcess>();
process.on('exit', () => {
  for (const child of live) child.kill('SIGKILL');
});

export class Pod {
  private constructor(
    private readonly child: ChildProcess,
    readonly pid: number,
    readonly url: string,
  ) {}

  static start(args: string[] = []): Promise<Pod> {
    const child = spawn(process.execPath, [join(__dirname, '..', 'pod.js'), ...args], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    live.add(child);
    child.on('exit', () => live.delete(child));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('pod did not start within 10 s')), 10_000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`pod exited with ${code} before it was ready`));
      });
      createInterface({ input: child.stdout! }).on('line', (line) => {
        try {
          const event = JSON.parse(line) as { kind: string; pid: number; url: string };
          if (event.kind !== 'ready') return;
          clearTimeout(timer);
          resolve(new Pod(child, event.pid, event.url));
        } catch {
          return;
        }
      });
    });
  }

  private exit(signal: NodeJS.Signals): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      this.child.once('exit', () => resolve());
      this.child.kill(signal);
    });
  }

  stop(): Promise<void> {
    return this.exit('SIGTERM');
  }

  // kill -9: nothing in the process gets to run, so nothing it kept in memory
  // could have been saved anywhere.
  crash(): Promise<void> {
    return this.exit('SIGKILL');
  }
}
