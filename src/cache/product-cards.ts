import { ProductCard, ProductCardsRepository } from '../repositories';
import { CacheAside, CacheRead } from './cache-aside';

export const cardKey = (productId: string): string => `card:product:${productId}`;

// The product card behind cache-aside. The TTL is always there; invalidate() is
// what a write to the product (price, stock) calls on top of it, so a changed card
// is read fresh on the next request instead of up to six minutes later.
export class ProductCards {
  constructor(
    private readonly repository: ProductCardsRepository,
    private readonly cache: CacheAside,
    // Extra latency for the loader: the demo's stand-in for an aggregate over a
    // production-sized order_items. It makes the stampede window wide enough to
    // watch; the lock does not depend on it.
    private readonly loadDelayMs = 0,
  ) {}

  get(productId: string): Promise<CacheRead<ProductCard>> {
    return this.cache.get(cardKey(productId), async () => {
      const card = await this.repository.findById(productId);
      if (this.loadDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.loadDelayMs));
      return card;
    });
  }

  invalidate(productId: string): Promise<void> {
    return this.cache.invalidate(cardKey(productId));
  }
}
