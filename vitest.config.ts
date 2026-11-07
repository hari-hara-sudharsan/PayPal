import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    env: { PACT_DB: ':memory:', PACT_AI: 'offline', PAYPAL_CLIENT_ID: '', PAYPAL_CLIENT_SECRET: '' },
  },
});
