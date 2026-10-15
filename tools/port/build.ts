// Compiles the generated C with Emscripten: one object per file, built in parallel, then one link.
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, type Toolchain } from '../recomp/toolchain.ts';

export interface BuildOptions {
  cDir: string;
  objDir: string;
  distDir: string;
  toolchain: Toolchain;
  optimize?: string;
  log: (msg: string) => void;
}

const COMPILE_FLAGS = ['-ffp-contract=off', '-Wall', '-Wno-unused-label', '-Wno-unused-variable', '-Wno-unused-but-set-variable', '-Wno-unused-function'];

function emcc(tc: Toolchain, args: string[], cwd: string): Promise<{ code: number; output: string }> {
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
  const headers = [...readdirSync(opts.cDir).filter((f) => f.endsWith('.h')).map((f) => join(opts.cDir, f)), join(repoRoot, 'runtime', 'cpu.h'), join(repoRoot, 'runtime', 'dispatch.h')];
  const newestHeader = Math.max(...headers.map((h) => statSync(h).mtimeMs));
  const jobs = sources.map((src) => {
    const obj = join(opts.objDir, `${src.replace(/^.*[\\/]/, '').replace(/\.c$/, '')}-${extraSources.includes(src) ? 'rt' : 'gen'}.o`);
    const stale = !existsSync(obj) || statSync(obj).mtimeMs < Math.max(statSync(src).mtimeMs, newestHeader);
    return { src, obj, stale };
  });
  const todo = jobs.filter((j) => j.stale);
  opts.log(`compiling ${todo.length} of ${jobs.length} C files`);
  const failures: string[] = [];
  let done = 0;
  const compileOne = async (job: { src: string; obj: string }) => {
    const r = await emcc(opts.toolchain, [opts.optimize ?? '-O1', ...COMPILE_FLAGS, `-I${join(repoRoot, 'runtime')}`, `-I${opts.cDir}`, '-c', job.src, '-o', job.obj], repoRoot);
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
    opts.optimize ?? '-O1', '-sENVIRONMENT=web,node', '-sALLOW_MEMORY_GROWTH=1', '-sEXIT_RUNTIME=1', '-sERROR_ON_UNDEFINED_SYMBOLS=1', '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sEXPORT_NAME=createOot',
    `@${list}`, '-o', out,
  ], repoRoot);
  if (r.code !== 0) throw new Error(`link failed:\n${r.output.slice(0, 4000)}`);
  return out;
}
