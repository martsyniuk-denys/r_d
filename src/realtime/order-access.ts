import { Principal } from '../auth/principal';

export interface OwnedOrder {
  id: string;
  buyer_id: string | null;
}

export type DenialReason = 'not_found' | 'anonymous' | 'forbidden';

export interface AccessDenial {
  reason: DenialReason;
  detail: string;
}

export type Access<T> = { ok: true; order: T } | { ok: false; denial: AccessDenial };

// The ownership rule, for every transport: HTTP, SSE and the WebSocket room. It
// runs on an order that is already loaded, because ownership is a fact about the
// order and a guard — which runs before the handler — has no order to look at.
//
//   no principal          → anonymous (401: authenticate first)
//   the buyer, or admin   → allowed
//   anybody else          → forbidden (403: you are known, and this is not yours)
export function access<T extends OwnedOrder>(
  orderId: string,
  order: T | undefined,
  principal: Principal | null,
): Access<T> {
  const deny = (reason: DenialReason, detail: string): Access<T> => ({
    ok: false,
    denial: { reason, detail },
  });

  if (principal === null) {
    return deny('anonymous', `Order '${orderId}' needs an authenticated caller.`);
  }

  if (!order) return deny('not_found', `Order '${orderId}' does not exist.`);

  if (order.buyer_id !== principal.userId && principal.role !== 'admin') {
    return deny('forbidden', `Order '${orderId}' does not belong to user '${principal.userId}'.`);
  }

  return { ok: true, order };
}
