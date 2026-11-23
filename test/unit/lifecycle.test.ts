import { ORDER_STATUSES, OrderStatus } from '../../src/entities/order.entity';
import { TRANSITIONS, canTransition, sourcesOf } from '../../src/orders/lifecycle';

describe('order lifecycle', () => {
  it('walks the main contour', () => {
    expect(canTransition('pending', 'confirmed')).toBe(true);
    expect(canTransition('confirmed', 'paid')).toBe(true);
    expect(canTransition('paid', 'shipped')).toBe(true);
  });

  it('lets a payment overtake the confirmation', () => {
    expect(canTransition('pending', 'paid')).toBe(true);
  });

  it('never goes back and never leaves a final status', () => {
    expect(canTransition('paid', 'pending')).toBe(false);
    expect(canTransition('shipped', 'paid')).toBe(false);
    expect(TRANSITIONS.cancelled).toEqual([]);
    expect(TRANSITIONS.refunded).toEqual([]);
  });

  it('cannot cancel what has been paid for — that is a refund', () => {
    expect(canTransition('paid', 'cancelled')).toBe(false);
    expect(canTransition('paid', 'refunded')).toBe(true);
  });

  it('is acyclic, so every status is reached at most once (the event id relies on it)', () => {
    const reachable = (from: OrderStatus, seen = new Set<OrderStatus>()): boolean =>
      TRANSITIONS[from].every((to) => !seen.has(to) && reachable(to, new Set([...seen, from, to])));
    for (const status of ORDER_STATUSES) expect(reachable(status)).toBe(true);
  });

  it('knows where each status can be reached from', () => {
    expect(sourcesOf('paid').sort()).toEqual(['confirmed', 'pending']);
    expect(sourcesOf('pending')).toEqual([]);
  });
});
