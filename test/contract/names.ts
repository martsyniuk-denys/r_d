import { join } from 'node:path';

export const CONSUMER = 'marketplace-web';
export const PROVIDER = 'marketplace-api';
export const PACTS_DIR = join(__dirname, '..', '..', 'pacts');
export const PACT_FILE = join(PACTS_DIR, `${CONSUMER}-${PROVIDER}.json`);
