import { join } from 'node:path';
import { defineConfig } from 'vitest/config';
import { defaultCacheDir } from './tools/port/cache.ts';

export default defineConfig({
  // The per-file timing cache lives in the shared build cache so that a fresh worktree starts its slowest files first.
  cacheDir: join(defaultCacheDir(), 'vitest'),
  test: {
    include: ['tools/**/*.test.ts', 'web/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 1_800_000,
    globalSetup: ['tools/recomp/global-setup.ts'],
    reporters: ['default', './tools/durations-reporter.ts'],
  },
});
