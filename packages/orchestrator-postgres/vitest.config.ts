import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
    ],
    // Skip tests when DATABASE_URL is not available (CI-friendly)
    ...(process.env.DATABASE_URL ? {} : { skip: true }),
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
