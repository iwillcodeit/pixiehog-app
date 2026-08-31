import { defineConfig } from 'vitest/config';

// Dedicated config: the root vite.config.ts loads the Remix plugin, which must not run under Vitest.
export default defineConfig({
  test: {
    include: ['extensions/**/*.test.ts'],
    environment: 'node',
  },
});
