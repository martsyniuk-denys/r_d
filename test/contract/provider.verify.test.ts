import { AddressInfo } from 'node:net';

import { Verifier, VerifierOptions } from '@pact-foundation/pact';
import { Pool } from 'pg';

import { createApp } from '../../src/bootstrap';
import { testPool } from '../testkit/database';
import { CONSUMER, PACT_FILE, PROVIDER } from './names';
import { providerVersion } from './provider-version';

const VERSION = providerVersion();

describe(`${PROVIDER} honours the contract published by ${CONSUMER}`, () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  let pool: Pool;
  let baseUrl: string;

  beforeAll(async () => {
    // setupFiles pointed the environment at the testcontainer before the app
    // graph was imported — see test/testkit/jest-setup-env.ts.
    pool = testPool();

    // The real application, wired by the same createApp() main.ts calls.
    app = await createApp();
    await app.listen(0, '127.0.0.1');

    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it('answers every interaction in the contract', async () => {
    const options: VerifierOptions = {
      provider: PROVIDER,
      providerBaseUrl: baseUrl,
      providerVersion: VERSION,
      logLevel: 'info',

      // Provider states put the database into the shape the interaction assumes.
      // Every one of them is idempotent, so the drill can be repeated.
      stateHandlers: {
        'a product with id p_1 exists': async () => {
          await pool.query(
            `INSERT INTO users (id, email, display_name, country, balance_minor)
             OVERRIDING SYSTEM VALUE
             VALUES (1, 'contract-seller@example.test', 'Contract seller', 'UA', 0)
             ON CONFLICT (id) DO NOTHING`,
          );
          await pool.query(
            `INSERT INTO products (id, seller_id, name, description, price_minor, currency, status, stock)
             OVERRIDING SYSTEM VALUE
             VALUES (1, 1, 'Mechanical keyboard', 'Tactile switches, PBT keycaps', 260000, 'UAH', 'active', 10)
             ON CONFLICT (id) DO NOTHING`,
          );
        },
        'no product with id p_999999999 exists': async () => {
          await pool.query(`DELETE FROM products WHERE id = 999999999`);
        },
      },
    };

    // The broker is the normal route; its address and token come from the secret
    // store through scripts/with-secrets.sh, never from a constant in this file.
    // With no broker configured the verification runs against the local pact file,
    // which is what makes `npm run verify:provider` work on a bare clone.
    const brokerUrl = process.env.PACT_BROKER_URL;
    if (brokerUrl !== undefined && brokerUrl !== '') {
      options.pactBrokerUrl = brokerUrl;

      // Only when there is one: the verifier rejects the key with an empty value,
      // and the broker that compose starts locally asks for no credentials.
      const token = process.env.PACT_BROKER_TOKEN;
      if (token !== undefined && token !== '') options.pactBrokerToken = token;

      options.consumerVersionSelectors = [{ latest: true }];
      options.publishVerificationResult = true;
      console.log(`verifying against the broker at ${brokerUrl} as version ${VERSION}`);
    } else {
      options.pactUrls = [PACT_FILE];
      console.log(`verifying against ${PACT_FILE} as version ${VERSION} (no broker configured)`);
    }

    const output = await new Verifier(options).verifyProvider();
    expect(output).toBeDefined();
  });
});
