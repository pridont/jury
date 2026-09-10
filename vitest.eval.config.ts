import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/eval/**/*.eval.ts'],
    environment: 'node',
    testTimeout: 300_000,
    hookTimeout: 60_000,
  },
});
