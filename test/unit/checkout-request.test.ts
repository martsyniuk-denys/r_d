import { mergeLines, requestHash } from '../../src/orders/place-order';

describe('checkout request identity', () => {
  it('merges repeated products and orders lines by product id', () => {
    expect(
      mergeLines([
        { productId: '10', qty: 1 },
        { productId: '2', qty: 1 },
        { productId: '10', qty: 2 },
      ]),
    ).toEqual([
      { productId: '2', qty: 1 },
      { productId: '10', qty: 3 },
    ]);
  });

  it('hashes the same cart in any order to the same request', () => {
    const a = requestHash([{ productId: '1', qty: 1 }, { productId: '2', qty: 2 }]);
    const b = requestHash([{ productId: '2', qty: 2 }, { productId: '1', qty: 1 }]);
    expect(a).toBe(b);
  });

  it('tells a different cart apart, so a reused key is refused', () => {
    expect(requestHash([{ productId: '1', qty: 1 }])).not.toBe(requestHash([{ productId: '1', qty: 2 }]));
  });
});
