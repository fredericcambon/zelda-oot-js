import { join } from 'node:path';
import { defineConfig } from 'vitest/config';
import { defaultCacheDir } from './tools/port/cache.ts';

/** The suites that boot the whole game in wasm (about 0.5 to 1.5 GB each) or start headless Chrome; they run in a project of their own with fewer workers. */
const HEAVY = [
  'tools/headless/actors-rom.test.ts',
  'tools/headless/entrance-variant-rom.test.ts',
  'tools/headless/headless-60hz.test.ts',
  'tools/headless/headless-forest.test.ts',
  'tools/headless/headless-state.test.ts',
  'tools/headless/headless.test.ts',
  'tools/headless/load-save-rom.test.ts',
  'tools/headless/title-card-rom.test.ts',
  'tools/gfx/frames.test.ts',
  'tools/gfx/smooth.test.ts',
  'tools/port/port.test.ts',
  'tools/saves/game.test.ts',
  'tools/sweep/sweep.test.ts',
  'web/boot-params.test.ts',
  'web/browser-saves.test.ts',
  'web/touch-browser.test.ts',
];

const common = {
  testTimeout: 120_000,
  hookTimeout: 1_800_000,
};

export default defineConfig({
  // The per-file timing cache lives in the shared build cache so that a fresh worktree starts its slowest files first.
  cacheDir: join(defaultCacheDir(), 'vitest'),
  test: {
    reporters: ['default', './tools/durations-reporter.ts'],
    maxWorkers: 6,
    projects: [
      // The projects do not inherit the root's options: the global setup, which builds the game, must run once, not once per project.
      { test: { ...common, name: 'light', include: ['tools/**/*.test.ts', 'web/**/*.test.ts'], exclude: HEAVY, maxWorkers: 6, globalSetup: ['tools/recomp/global-setup.ts'] } },
      { test: { ...common, name: 'heavy', include: HEAVY, maxWorkers: 2 } },
    ],
  },
});
