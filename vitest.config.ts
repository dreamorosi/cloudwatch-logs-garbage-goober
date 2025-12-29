/// <reference types="vitest" />

import { coverageConfigDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 10000,
    setupFiles: ['./tests/setupEnv.ts'],
    coverage: {
      provider: 'v8',
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
      include: ['src/**'],
      exclude: [
        ...coverageConfigDefaults.exclude,
        'src/types.ts',
        'src/stack.ts',
      ],
    },
  },
});
