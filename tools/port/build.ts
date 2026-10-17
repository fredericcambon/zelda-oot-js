// Compiles the generated C with Emscripten: one object per file, built in parallel, then one link.
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, type Toolchain } from '../recomp/toolchain.ts';

/**
 * -O2 runs the recompiled game about twice as fast as -O1 and makes a wasm half the size; the game's memory is bit-identical
 * after 19,000 frames of the scripted new game.
 */
export const DEFAULT_OPTIMIZE = '-O2';

export interface BuildOptions {
  cDir: string;
  objDir: string;
  distDir: string;
  toolchain: Toolchain;
  optimize?: string;
  /** Records every recompiled function's entry (see OOT_TRACE in runtime/cpu.h). */
  traceCalls?: boolean;
  /** Records the functions run, the OS calls made and the accesses beyond RDRAM (see OOT_COVERAGE in runtime/cpu.h). */
  coverage?: boolean;
  log: (msg: string) => void;
}

/** The display-list interpreter's C sources, a module of its own that also builds without the game (runtime/gfx/gfx.h). */
export const GFX_DIR = join(repoRoot, 'runtime', 'gfx');

/** The runtime's C sources: every file of runtime/ and of runtime/gfx/ (the unit tests live in another subdirectory). */
export function runtimeSources(): string[] {
  const dir = join(repoRoot, 'runtime');
  return [dir, GFX_DIR].flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.c')).map((f) => join(d, f)));
}

/** Host entry points (runtime/headless.c) and the allocator the host copies the ROM through. */
const EXPORTS = ['_main', '_malloc', '_free', '_oot_boot', '_oot_frame', '_oot_idle', '_oot_frames', '_oot_gfx_tasks', '_oot_audio_tasks', '_oot_jpeg_tasks', '_oot_retraces', '_oot_fatal_message', '_oot_rd32', '_oot_rdram', '_oot_rom_base', '_oot_rom_size', '_oot_pad_set', '_oot_sram', '_oot_sram_size', '_oot_sram_take_dirty', '_oot_trace_count', '_oot_trace_at', '_oot_rsp_task_kinds', '_oot_rsp_task_kind', '_oot_cov_enabled', '_oot_cov_functions', '_oot_cov_os_count', '_oot_cov_os_addr', '_oot_cov_os_hits', '_oot_cov_outside_count', '_oot_cov_outside', '_gfx_run', '_gfx_run_ram', '_gfx_result', '_gfx_reset', '_gfx_layout'];

const COMPILE_FLAGS = ['-ffp-contract=off', '-Wall', '-Wno-unused-label', '-Wno-unused-variable', '-Wno-unused-but-set-variable', '-Wno-unused-function'];

export function emcc(tc: Toolchain, args: string[], cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(tc.python, [tc.emcc, ...args], { cwd, env: tc.env });
    let output = '';
    child.stdout.on('data', (d: Buffer) => (output += d));
    child.stderr.on('data', (d: Buffer) => (output += d));
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

/** Compiles every C file whose object is missing or older than the source, `cpus` at a time. Returns the objects. */
export async function compileAll(opts: BuildOptions, extraSources: string[]): Promise<string[]> {
  mkdirSync(opts.objDir, { recursive: true });
  const sources = [
    ...readdirSync(opts.cDir).filter((f) => f.endsWith('.c')).map((f) => join(opts.cDir, f)),
    ...extraSources,
  ];
  const headers = [...readdirSync(opts.cDir).filter((f) => f.endsWith('.h')).map((f) => join(opts.cDir, f)), ...readdirSync(join(repoRoot, 'runtime')).filter((f) => f.endsWith('.h')).map((f) => join(repoRoot, 'runtime', f))];
  const newestHeader = Math.max(...headers.map((h) => statSync(h).mtimeMs));
  const gfxHeader = Math.max(...readdirSync(GFX_DIR).filter((f) => f.endsWith('.h')).map((f) => statSync(join(GFX_DIR, f)).mtimeMs));
  const jobs = sources.map((src) => {
    const obj = join(opts.objDir, `${src.replace(/^.*[\\/]/, '').replace(/\.c$/, '')}-${extraSources.includes(src) ? 'rt' : 'gen'}.o`);
    const inGfx = src.startsWith(GFX_DIR);
    const stale = !existsSync(obj) || statSync(obj).mtimeMs < Math.max(statSync(src).mtimeMs, newestHeader, inGfx ? gfxHeader : 0);
    return { src, obj, stale };
  });
  const todo = jobs.filter((j) => j.stale);
  opts.log(`compiling ${todo.length} of ${jobs.length} C files`);
  const failures: string[] = [];
  let done = 0;
  const compileOne = async (job: { src: string; obj: string }) => {
    const r = await emcc(opts.toolchain, [opts.optimize ?? DEFAULT_OPTIMIZE, ...COMPILE_FLAGS, ...(opts.traceCalls ? ['-DOOT_TRACE'] : []), ...(opts.coverage ? ['-DOOT_COVERAGE'] : []), `-I${join(repoRoot, 'runtime')}`, `-I${opts.cDir}`, '-c', job.src, '-o', job.obj], repoRoot);
    if (r.code !== 0) failures.push(`${job.src}:
${r.output}`);
    else if (/warning:/.test(r.output)) opts.log(`${job.src}:
${r.output.slice(0, 2000)}`);
    if (++done % 25 === 0) opts.log(`  ${done}/${total}`);
  };
  // The first compile fills Emscripten's cache of system headers; it runs alone so that workers do not race on it.
  const total = todo.length;
  const first = todo.shift();
  if (first) await compileOne(first);
  const worker = async () => {
    for (let job = todo.shift(); job; job = todo.shift()) await compileOne(job);
  };
  await Promise.all(Array.from({ length: Math.max(1, cpus().length - 1) }, worker));
  if (failures.length > 0) throw new Error(`${failures.length} C files failed to compile:\n${failures.slice(0, 3).join('\n')}`);
  return jobs.map((j) => j.obj);
}

export async function link(opts: BuildOptions, objects: string[]): Promise<string> {
  mkdirSync(opts.distDir, { recursive: true });
  const out = join(opts.distDir, 'oot.js');
  opts.log(`linking ${objects.length} objects into ${out}`);
  // Hundreds of objects exceed the command-line limit, so they go through a response file.
  const list = join(opts.objDir, 'objects.rsp');
  writeFileSync(list, objects.map((o) => `"${o.replaceAll('\\', '/')}"`).join('\n'));
  const r = await emcc(opts.toolchain, [
    opts.optimize ?? DEFAULT_OPTIMIZE, '-sENVIRONMENT=web,node', '-sALLOW_MEMORY_GROWTH=1', '-sASYNCIFY', '-sEXIT_RUNTIME=0', '-sERROR_ON_UNDEFINED_SYMBOLS=1', '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sEXPORT_NAME=createOot',
    `-sEXPORTED_FUNCTIONS=${EXPORTS.join(',')}`, '-sEXPORTED_RUNTIME_METHODS=HEAPU8,UTF8ToString,Asyncify',
    `@${list}`, '-o', out,
  ], repoRoot);
  if (r.code !== 0) throw new Error(`link failed:\n${r.output.slice(0, 4000)}`);
  return out;
}
