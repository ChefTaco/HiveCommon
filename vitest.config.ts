import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'text'],
      // A floor, not a target: CI fails when coverage drops below today's level. The package
      // as a whole stays at 99 % lines and 98 % branches; every module must stay above the
      // per-file minimums. Raise them as tests improve; never lower them to land a change.
      thresholds: {
        lines: 99.5,
        statements: 99,
        branches: 98,
        functions: 97,
        perFile: { lines: 97, statements: 96, branches: 90, functions: 80 },
      },
    },
  },
});
