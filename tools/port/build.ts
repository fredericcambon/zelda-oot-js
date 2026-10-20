// Compiles the generated C with Emscripten: one object per file, built in parallel, then one link. Objects and the link
// output come from the shared cache (cache.ts) when their inputs are unchanged.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { repoRoot, type Toolchain } from '../recomp/toolchain.ts';
import { hashFile, hashKey, type Cache } from './cache.ts';
import { gate, jobLimit } from './limits.ts';

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
  /** The shared build cache; absent when caching is off. */
  cache?: Cache;
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
const EXPORTS = ['_main', '_malloc', '_free', '_oot_boot', '_oot_frame', '_oot_idle', '_oot_frames', '_oot_gfx_tasks', '_oot_audio_tasks', '_oot_jpeg_tasks', '_oot_retraces', '_oot_fatal_message', '_oot_rd32', '_oot_rdram', '_oot_rom_base', '_oot_rom_size', '_oot_pad_set', '_oot_sram', '_oot_sram_size', '_oot_sram_take_dirty', '_oot_trace_count', '_oot_trace_at', '_oot_rsp_task_kinds', '_oot_rsp_task_kind', '_oot_cov_enabled', '_oot_cov_functions', '_oot_cov_os_count', '_oot_cov_os_addr', '_oot_cov_os_hits', '_oot_cov_outside_count', '_oot_cov_outside', '_gfx_run', '_gfx_run_ram', '_gfx_result', '_gfx_reset', '_gfx_layout', '_gfx_trace_vertices', '_gfx_vertex_trace', '_gfx_vertex_trace_length', '_gfx_keep', '_gfx_run_kept', '_gfx_forget_kept', '_gfx_motion_record', '_gfx_motion_count', '_gfx_motion_matrices', '_gfx_motion_vertex_load_count', '_gfx_motion_vertex_loads', '_gfx_motion_input', '_gfx_motion_commit', '_gfx_set_pixel_lighting', '_gfx_light_result', '_gfx_set_camera_output', '_gfx_camera_result'];

const COMPILE_FLAGS = ['-ffp-contract=off', '-Wall', '-Wno-unused-label', '-Wno-unused-variable', '-Wno-unused-but-set-variable', '-Wno-unused-function'];

/** Every emcc run in this process goes through it, so that no set of concurrent builds starts more than `jobLimit()` at once. */
const emccSlots = gate();

export function emcc(tc: Toolchain, args: string[], cwd: string): Promise<{ code: number; output: string }> {
  return emccSlots(() => new Promise((resolve) => {
    const child = spawn(tc.python, [tc.emcc, ...args], { cwd, env: tc.env });
    let output = '';
    child.stdout.on('data', (d: Buffer) => (output += d));
    child.stderr.on('data', (d: Buffer) => (output += d));
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  }));
}

/** The Emscripten release in use: what decides whether two compilers produce the same object. */
export function emscriptenVersion(tc: Toolchain): string {
  const dir = dirname(tc.emcc);
  const files = [join(dir, 'emscripten-version.txt'), join(dir, 'emscripten-revision.txt'), join(dir, '..', '.emsdk_version')];
  const found = files.filter(existsSync).map((f) => readFileSync(f, 'utf8').trim());
  if (found.length > 0) return found.join('|');
  const r = spawnSync(tc.python, [tc.emcc, '--version'], { env: tc.env, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : 'unknown';
}

const INCLUDE = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm;

/** Resolves the includes of a C file the way the compile does: its own folder, then the -I folders in order. Headers found nowhere (the toolchain's) are not inputs. */
function makeIncludeResolver(searchDirs: string[]) {
  const direct = new Map<string, string[]>();
  const includesOf = (file: string): string[] => {
    let list = direct.get(file);
    if (!list) {
      list = [];
      for (const m of readFileSync(file, 'utf8').matchAll(INCLUDE)) {
        const found = [dirname(file), ...searchDirs].map((d) => join(d, m[1]!)).find(existsSync);
        if (found) list.push(found);
      }
      direct.set(file, list);
    }
    return list;
  };
  /** Every header the file includes, directly or not. */
  return (file: string): string[] => {
    const seen = new Set<string>();
    const pending = [file];
    for (let f = pending.pop(); f !== undefined; f = pending.pop()) {
      for (const inc of includesOf(f)) {
        if (seen.has(inc)) continue;
        seen.add(inc);
        pending.push(inc);
      }
    }
    return [...seen];
  };
}

export interface CompiledObject {
  path: string;
  /** Hash of everything that determines the object's bytes. */
  key: string;
}

/**
 * Brings the object of every C file up to date, `OOT_JOBS` compiles at a time: an object whose key is unchanged stays, one found in
 * the shared cache is copied from it, and the rest is compiled and stored. Returns the objects.
 */
interface ObjectJob extends CompiledObject {
  src: string;
  name: string;
}

function compileFlags(opts: BuildOptions): string[] {
  return [opts.optimize ?? DEFAULT_OPTIMIZE, ...COMPILE_FLAGS, ...(opts.traceCalls ? ['-DOOT_TRACE'] : []), ...(opts.coverage ? ['-DOOT_COVERAGE'] : [])];
}

/** One job per C file of `opts.cDir` and of `extraSources`, each with the key of its object. */
export function planObjects(opts: BuildOptions, extraSources: string[], version: string): ObjectJob[] {
  const sources = [
    ...readdirSync(opts.cDir).filter((f) => f.endsWith('.c')).sort().map((f) => join(opts.cDir, f)),
    ...extraSources,
  ];
  const flags = compileFlags(opts);
  const includesOf = makeIncludeResolver([join(repoRoot, 'runtime'), opts.cDir]);
  return sources.map((src) => {
    const name = `${basename(src).replace(/.c$/, '')}-${extraSources.includes(src) ? 'rt' : 'gen'}.o`;
    const headers = includesOf(src).map((h) => `${basename(h)}=${hashFile(h)}`).sort();
    return { src, name, path: join(opts.objDir, name), key: hashKey('obj', version, name, hashFile(src), ...flags, '--', ...headers) };
  });
}

const LINK_FLAGS = (optimize: string) => [
  optimize, '-sENVIRONMENT=web,node', '-sALLOW_MEMORY_GROWTH=1', '-sASYNCIFY', '-sEXIT_RUNTIME=0', '-sERROR_ON_UNDEFINED_SYMBOLS=1', '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sEXPORT_NAME=createOot',
  `-sEXPORTED_FUNCTIONS=${EXPORTS.join(',')}`, '-sEXPORTED_RUNTIME_METHODS=HEAPU8,UTF8ToString,Asyncify',
];

/** The key of the link output: the compiler release, the link flags and every object (its key and its bytes), in link order. */
export function linkKey(version: string, optimize: string, objects: CompiledObject[]): string {
  return hashKey('link', version, ...LINK_FLAGS(optimize), '--', ...objects.map((o) => `${basename(o.path)}=${o.key}=${existsSync(o.path) ? hashFile(o.path) : 'absent'}`));
}

const LINK_OUTPUTS = ['oot.js', 'oot.wasm'];

/** A cached link output is only as good as its wasm: an empty or foreign file is rejected. */
const isLinkOutput = (path: string, data: Buffer) => path !== 'oot.wasm' || (data.length > 8 && data.readUInt32BE(0) === 0x0061736d);

/**
 * Brings the object of every C file up to date, `OOT_JOBS` compiles at a time: an object whose key is unchanged stays, one found in
 * the shared cache is copied from it, and the rest is compiled and stored. Returns the objects.
 */
export async function compileAll(opts: BuildOptions, extraSources: string[]): Promise<CompiledObject[]> {
  mkdirSync(opts.objDir, { recursive: true });
  const flags = compileFlags(opts);
  const jobs = planObjects(opts, extraSources, emscriptenVersion(opts.toolchain));
  const keyFile = (j: { path: string }) => `${j.path}.key`;
  // The stamp holds the object's own hash too, so an object truncated or replaced after its compile is rebuilt.
  const stamp = (j: { path: string; key: string }) => `${j.key}:${hashFile(j.path)}`;
  const current = (j: { path: string; key: string }) => existsSync(j.path) && existsSync(keyFile(j)) && readFileSync(keyFile(j), 'utf8') === stamp(j);
  const todo = jobs.filter((j) => !current(j));
  let hits = 0;
  if (opts.cache) {
    for (let i = todo.length - 1; i >= 0; i--) {
      const j = todo[i]!;
      if (opts.cache.restore('obj', j.key, opts.objDir)) {
        writeFileSync(keyFile(j), stamp(j));
        todo.splice(i, 1);
        hits++;
      }
    }
  }
  const compiled = todo.length;
  opts.log(`compiling ${compiled} of ${jobs.length} C files (${jobs.length - compiled - hits} up to date${opts.cache ? `, ${hits} from the cache` : ''})`);
  const failures: string[] = [];
  let done = 0;
  const compileOne = async (job: (typeof jobs)[number]) => {
    const r = await emcc(opts.toolchain, [...flags, `-I${join(repoRoot, 'runtime')}`, `-I${opts.cDir}`, '-c', job.src, '-o', job.path], repoRoot);
    if (r.code !== 0) failures.push(`${job.src}:
${r.output}`);
    else {
      if (/warning:/.test(r.output)) opts.log(`${job.src}:
${r.output.slice(0, 2000)}`);
      writeFileSync(keyFile(job), stamp(job));
      opts.cache?.store('obj', job.key, opts.objDir, [job.name]);
    }
    if (++done % 25 === 0) opts.log(`  ${done}/${compiled}`);
  };
  // The first compile fills Emscripten's cache of system headers; it runs alone so that workers do not race on it.
  const first = todo.shift();
  if (first) await compileOne(first);
  const worker = async () => {
    for (let job = todo.shift(); job; job = todo.shift()) await compileOne(job);
  };
  await Promise.all(Array.from({ length: jobLimit() }, worker));
  if (failures.length > 0) throw new Error(`${failures.length} C files failed to compile:\n${failures.slice(0, 3).join('\n')}`);
  return jobs.map((j) => ({ path: j.path, key: j.key }));
}

export async function link(opts: BuildOptions, objects: CompiledObject[]): Promise<string> {
  mkdirSync(opts.distDir, { recursive: true });
  const out = join(opts.distDir, 'oot.js');
  const optimize = opts.optimize ?? DEFAULT_OPTIMIZE;
  const key = linkKey(emscriptenVersion(opts.toolchain), optimize, objects);
  if (opts.cache?.restore('link', key, opts.distDir, isLinkOutput)) {
    opts.log(`link: cache hit, restored ${out}`);
    return out;
  }
  opts.log(`linking ${objects.length} objects into ${out}${opts.cache ? ' (cache miss)' : ''}`);
  // Hundreds of objects exceed the command-line limit, so they go through a response file.
  const list = join(opts.objDir, 'objects.rsp');
  writeFileSync(list, objects.map((o) => `"${o.path.replaceAll('\\', '/')}"`).join('\n'));
  const r = await emcc(opts.toolchain, [...LINK_FLAGS(optimize), `@${list}`, '-o', out], repoRoot);
  if (r.code !== 0) throw new Error(`link failed:\n${r.output.slice(0, 4000)}`);
  if (LINK_OUTPUTS.every((f) => existsSync(join(opts.distDir, f))) && isLinkOutput('oot.wasm', readFileSync(join(opts.distDir, 'oot.wasm')))) {
    opts.cache?.store('link', key, opts.distDir, LINK_OUTPUTS);
  }
  return out;
}
