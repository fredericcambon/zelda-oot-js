// Builds and loads the display-list interpreter alone, as a module of its own, for the tools and tests that run display lists
// over a RAM image without the game.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { emcc, GFX_DIR } from '../port/build.ts';
import { ensureToolchain, repoRoot, type Toolchain } from '../recomp/toolchain.ts';
import { CDisplayListInterpreter, type GfxTraceCore } from './c-dl.ts';

const GFX_EXPORTS = [
  '_malloc', '_free', '_gfx_run_ram', '_gfx_result', '_gfx_reset', '_gfx_layout', '_gfx_decode_texture', '_gfx_trace_vertices', '_gfx_vertex_trace',
  '_gfx_vertex_trace_length', '_gfx_motion_record', '_gfx_motion_count', '_gfx_motion_matrices', '_gfx_motion_vertex_load_count', '_gfx_motion_vertex_loads', '_gfx_motion_input', '_gfx_motion_commit',
  '_gfx_set_pixel_lighting', '_gfx_light_result',
];

const BUILD_TIMEOUT_MS = 10 * 60_000;

/** The standalone module's exports. */
export interface GfxModule extends GfxTraceCore {
  _gfx_decode_texture(source: number, out: number): void;
}

/** Builds the interpreter alone into a module under `outDir` (rebuilt when a source is newer) and loads it. */
export async function loadGfxModule(toolchain: Toolchain, outDir: string): Promise<GfxModule> {
  const sources = readdirSync(GFX_DIR).filter((f) => (f.endsWith('.c') && f !== 'task.c') || f.endsWith('.h')).map((f) => join(GFX_DIR, f));
  const out = join(outDir, 'gfx.mjs');
  const newest = Math.max(...sources.map((s) => statSync(s).mtimeMs));
  const stale = () => !existsSync(out) || statSync(out).mtimeMs < newest;
  // Test files run in parallel processes: one builds while the others wait for it.
  const lock = join(outDir, 'build.lock');
  mkdirSync(outDir, { recursive: true });
  for (;;) {
    if (existsSync(lock)) {
      // A build that died leaves its lock behind.
      if (Date.now() - statSync(lock).mtimeMs > BUILD_TIMEOUT_MS) rmSync(lock, { recursive: true, force: true });
      else await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    if (!stale()) break;
    try {
      mkdirSync(lock);
    } catch {
      continue;
    }
    try {
      await build();
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
  async function build(): Promise<void> {
    const r = await emcc(toolchain, [
      '-O2', '-ffp-contract=off', '-Wall', '-sENVIRONMENT=node', '-sALLOW_MEMORY_GROWTH=1', '-sMODULARIZE=1', '-sEXPORT_ES6=1',
      `-sEXPORTED_FUNCTIONS=${GFX_EXPORTS.join(',')}`, '-sEXPORTED_RUNTIME_METHODS=HEAPU8',
      ...sources.filter((s) => s.endsWith('.c')), '-o', out,
    ], repoRoot);
    if (r.code !== 0) throw new Error(`the interpreter failed to build:\n${r.output.slice(0, 4000)}`);
  }
  const factory = (await import(/* @vite-ignore */ `${pathToFileURL(out).href}?${statSync(out).mtimeMs}`)).default as (opts: object) => Promise<GfxModule>;
  return factory({ print: () => {}, printErr: (m: string) => console.error(m) });
}

let shared: Promise<GfxModule> | undefined;

/** The standalone module, built on first use under out/gfx and shared by the callers of the process. */
export function sharedGfxModule(): Promise<GfxModule> {
  return (shared ??= loadGfxModule(ensureToolchain(), resolve('out', 'gfx')));
}

/** An interpreter over the shared standalone module. Its results are valid until the next run of any interpreter on that module. */
export async function sharedInterpreter(): Promise<CDisplayListInterpreter> {
  return new CDisplayListInterpreter(await sharedGfxModule());
}
