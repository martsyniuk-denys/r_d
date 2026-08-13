export class ResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResolutionError';
  }
}

export class CircularDependencyError extends ResolutionError {
  readonly chain: readonly string[];

  constructor(chain: string[]) {
    super(`Circular dependency detected: ${chain.join(' -> ')}`);
    this.name = 'CircularDependencyError';
    this.chain = chain;
  }
}
