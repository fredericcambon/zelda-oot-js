import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tools/**/*.test.ts'], testTimeout: 120_000, hookTimeout: 1_800_000, globalSetup: ['tools/recomp/global-setup.ts'] },
});
