import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { Request, Response } from 'express';

import { toProblem } from './problem';

/**
 * Catches everything raised inside Nest's pipeline (controllers, services and
 * the response validator) and serves it as application/problem+json.
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    const problem = toProblem(exception, req);
    res.status(problem.status).type('application/problem+json').json(problem);
  }
}
