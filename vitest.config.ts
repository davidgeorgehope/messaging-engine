import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 900_000, // 15 minutes — AI calls are slow
    hookTimeout: 120_000,
    pool: 'forks',
    singleFork: true, // SQLite isn't thread-safe
  },
});
