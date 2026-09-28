// `npm run test:emr` — EMR tests against a real embedded Postgres with row-level security on.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/emr-db/**/*.test.js'],
    globalSetup: ['test/emr-db/global-setup.js'],
    setupFiles: ['test/emr-db/env-setup.js'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
