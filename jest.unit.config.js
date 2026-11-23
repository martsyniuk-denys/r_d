/**
 * Unit suite: the domain rules on their own — no HTTP, no database, no container,
 * so it runs in a second and can sit first in every pipeline.
 */
const base = require('./jest.config');

module.exports = {
  ...base,
  testMatch: ['<rootDir>/test/unit/**/*.test.ts'],
  globalSetup: undefined,
  globalTeardown: undefined,
  testTimeout: 5_000,
};
