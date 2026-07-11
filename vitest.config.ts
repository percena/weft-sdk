import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/e2e-tests/src/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    testTimeout: 30000,
  },
})
