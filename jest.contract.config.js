const base = require('./jest.config');

// The consumer test talks to Pact's own mock provider, so it needs no database
// and no container: globalSetup and globalTeardown are deliberately dropped.
const { globalSetup, globalTeardown, ...withoutContainer } = base;

module.exports = {
  ...withoutContainer,
  testMatch: ['<rootDir>/test/contract/consumer.pact.test.ts'],
};
