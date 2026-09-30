const base = require('./jest.config');

module.exports = {
  ...base,
  setupFiles: ['<rootDir>/test/testkit/jest-setup-env.ts'],
  testMatch: ['<rootDir>/test/e2e/**/*.test.ts'],
};
