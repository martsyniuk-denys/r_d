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

export interface FieldError {
  field: string;
  constraints: string[];
}

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export class ValidationFailedError extends HttpError {
  readonly errors: readonly FieldError[];

  constructor(errors: FieldError[]) {
    super(400, 'Validation failed');
    this.name = 'ValidationFailedError';
    this.errors = errors;
  }
}
