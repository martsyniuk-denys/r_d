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

// The single rule both transports enforce. An order created without an
// X-User-Id header has no buyer and its stream is public — that is the demo
// order the acceptance criteria follow with a bare curl. An order that does
// have a buyer is private: an anonymous connection is refused, a different
// user is refused, and only the buyer is let into the room.
export function access<T extends OwnedOrder>(
  orderId: string,
  order: T | undefined,
  userId: string | null,
): Access<T> {
  const deny = (reason: DenialReason, detail: string): Access<T> => ({
    ok: false,
    denial: { reason, detail },
  });

  if (!order) return deny('not_found', `Order '${orderId}' does not exist.`);

  if (order.buyer_id !== null) {
    if (userId === null) {
      return deny('anonymous', `Order '${orderId}' belongs to a user; this request has no identity.`);
    }
    if (order.buyer_id !== userId) {
      return deny('forbidden', `Order '${orderId}' does not belong to '${userId}'.`);
    }
  }

  return { ok: true, order };
}
