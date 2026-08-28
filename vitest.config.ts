import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Harness runs are minutes long by design: a soak profile is 20 minutes and
    // the baseline test deliberately runs three times in a row.
    testTimeout: 90 * 60_000,
    hookTimeout: 15 * 60_000,
    // Every test drives the same Docker stack on fixed host ports, so they must
    // never overlap.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    reporters: ['verbose'],
    include: ['tests/**/*.test.ts'],
  },
})
