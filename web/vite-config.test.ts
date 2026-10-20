import { describe, expect, it } from 'vitest';
import type { ConfigEnv, UserConfig } from 'vite';
import config from '../vite.config.ts';

describe('vite.config.ts', () => {
  it('never listens on 5173, the Overseer app UI port, and fails instead of moving', async () => {
    const env: ConfigEnv = { command: 'serve', mode: 'development' };
    const resolved = (typeof config === 'function' ? await config(env) : await config) as UserConfig;
    for (const section of [resolved.server, resolved.preview]) {
      expect(section?.port).toBeTypeOf('number');
      expect(section?.port).not.toBe(5173);
      expect(section?.strictPort).toBe(true);
      expect(section?.host).toBe('127.0.0.1');
    }
  });
});
