import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    fileParallelism: false,
    globalSetup: ['./src/tests/global-setup.ts'],
    env: {
      DATABASE_URL:
        'postgresql://postgres:postgres@localhost:5432/adpulse_test?schema=public',
    },
  },
});
