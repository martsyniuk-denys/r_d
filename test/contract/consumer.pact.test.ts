import { MatchersV3, PactV3 } from '@pact-foundation/pact';

import { CONSUMER, PACTS_DIR, PROVIDER } from './names';

const { like, integer, regex, string } = MatchersV3;

// The storefront the API is built for. It never sees the real service here — it
// talks to Pact's mock provider, and what it asks for becomes the contract.
const provider = new PactV3({
  consumer: CONSUMER,
  provider: PROVIDER,
  dir: PACTS_DIR,
  logLevel: 'warn',
});

interface ProductView {
  id: string;
  title: string;
  price_cents: number;
  currency: string;
}

async function fetchProduct(baseUrl: string, id: string): Promise<ProductView> {
  const response = await fetch(`${baseUrl}/products/${id}`);
  if (!response.ok) throw new Error(`product page got ${response.status}`);
  return (await response.json()) as ProductView;
}

describe(`${CONSUMER} → ${PROVIDER}`, () => {
  it('reads a product for the catalogue page', async () => {
    provider
      .given('a product with id p_1 exists')
      .uponReceiving('a request for the product page of p_1')
      .withRequest({ method: 'GET', path: '/products/p_1' })
      .willRespondWith({
        status: 200,
        headers: { 'Content-Type': regex(/application\/json.*/, 'application/json; charset=utf-8') },
        // Types, not values: a new price in the catalogue must not break the contract.
        body: like({
          id: string('p_1'),
          title: string('Mechanical keyboard'),
          price_cents: integer(260_000),
          currency: regex(/UAH|USD|EUR/, 'UAH'),
          created_at: regex(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
            '2026-01-15T09:30:00.000Z',
          ),
        }),
      });

    await provider.executeTest(async (mockServer) => {
      const product = await fetchProduct(mockServer.url, 'p_1');

      expect(product.id).toBe('p_1');
      expect(typeof product.price_cents).toBe('number');
    });
  });

  it('is told in problem+json when a product is gone', async () => {
    provider
      .given('no product with id p_999999999 exists')
      .uponReceiving('a request for a product that is not in the catalogue')
      .withRequest({ method: 'GET', path: '/products/p_999999999' })
      .willRespondWith({
        status: 404,
        headers: {
          'Content-Type': regex(
            /application\/problem\+json.*/,
            'application/problem+json; charset=utf-8',
          ),
        },
        body: like({
          type: string('about:blank'),
          title: string('Not Found'),
          status: integer(404),
          detail: string("Product 'p_999999999' does not exist."),
          instance: string('/products/p_999999999'),
        }),
      });

    await provider.executeTest(async (mockServer) => {
      const response = await fetch(`${mockServer.url}/products/p_999999999`);

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ status: 404 });
    });
  });
});
