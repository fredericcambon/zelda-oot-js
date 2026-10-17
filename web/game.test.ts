import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { startGame } from './game.ts';
import type { AudioSink } from './audio.ts';
import type { Renderer } from './renderer.ts';

// A module that imports env.f, which the glue below does not provide.
const NEEDS_IMPORT = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 2, 7, 1, 1, 0x65, 1, 0x66, 0, 0]);

describe('startGame', () => {
  it('rejects when the wasm cannot be instantiated, instead of waiting for the module forever', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oot-glue-'));
    try {
      // Like Emscripten's glue: its promise settles only when the instantiateWasm hook reports an instance.
      const glue = join(dir, 'glue.mjs');
      writeFileSync(glue, 'export default (opts) => new Promise(() => { opts.instantiateWasm({}, () => {}); });');
      const wasm = { module: Promise.resolve(new WebAssembly.Module(NEEDS_IMPORT)) };
      await expect(startGame(new Uint8Array(4), {} as Renderer, {} as AudioSink, wasm, pathToFileURL(glue).href)).rejects.toThrow(/import|LinkError/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
