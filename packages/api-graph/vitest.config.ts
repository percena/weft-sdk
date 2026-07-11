import { defineConfig } from 'vitest/config'

// Per-package config so this package's filtered `pnpm test` resolves test files.
// Without this, vitest walks up to the repo-root vitest.config.ts and applies
// its workspace-wide `include` (`packages/*/src/**/*.test.ts`) relative to THIS
// package's cwd — matching nothing → "No test files found, exiting with code 1".
// (skills/integrate-weft-kit/SKILL.md:76 tells integrators to run the filtered
// command; Phase 2a follows SKILL.md step-by-step.)
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
})
