/**
 * Integration suite: repositories against a real Postgres started from the test
 * run itself. reporters: ['default'] is not decoration — Jest 30 picks a reporter
 * from the environment when the field is missing, and the compact one it chooses
 * in some runners prints no PASS lines and no test names at all.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  reporters: ['default'],
  maxWorkers: 1,
  testMatch: ['<rootDir>/test/integration/**/*.test.ts'],
  globalSetup: '<rootDir>/test/testkit/global-setup.ts',
  globalTeardown: '<rootDir>/test/testkit/global-teardown.ts',
  testTimeout: 180_000,
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
  },
};
