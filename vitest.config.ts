import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 300_000, // 5 minutes per test — Flash should be fast
    hookTimeout: 120_000,
    pool: 'forks',
    singleFork: true, // SQLite isn't thread-safe
  },
});
