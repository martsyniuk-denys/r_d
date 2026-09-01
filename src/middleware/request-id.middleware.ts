import { RequestContext, createRequestStore } from '../context/request-context';
import type { ExecutionContext, Middleware } from '../lifecycle';

export class RequestIdMiddleware implements Middleware {
  async use(context: ExecutionContext, next: () => Promise<void>): Promise<void> {
    context.res.setHeader('x-request-id', context.requestId);

    await RequestContext.run(createRequestStore(context.requestId), next);
  }
}
