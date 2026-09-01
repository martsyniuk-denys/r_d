import { HttpError, ValidationError, type FieldError } from '../errors';
import type { ExceptionFilter, ExecutionContext } from '../lifecycle';
import { send } from '../response';

export interface ErrorBody {
  statusCode: number;
  message: string;
  requestId: string;
  errors?: readonly FieldError[];
}

export type ErrorSink = (error: unknown) => void;

export class HttpExceptionFilter implements ExceptionFilter {
  private readonly report: ErrorSink;

  constructor(report: ErrorSink = (error) => console.error(error)) {
    this.report = report;
  }

  catch(error: unknown, context: ExecutionContext): void {
    const body = this.toBody(error, context);

    send(context.res, body.statusCode, body);
  }

  private toBody(error: unknown, context: ExecutionContext): ErrorBody {
    const requestId = context.requestId;

    if (error instanceof ValidationError) {
      return { statusCode: 400, message: error.message, requestId, errors: error.errors };
    }

    if (error instanceof HttpError) {
      return { statusCode: error.status, message: error.message, requestId };
    }

    this.report(error);

    return { statusCode: 500, message: 'Internal server error', requestId };
  }
}
