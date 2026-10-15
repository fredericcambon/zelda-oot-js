// Runs Ghidra headless over the wrapped ELF images and collects the JSON our export script writes.

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, createWriteStream } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const toolsDir = join(root, '.tools');
const GHIDRA_DIR = join(toolsDir, 'ghidra_12.1.4_PUBLIC');
const JDK_DIR = join(toolsDir, 'jdk-21');
const SCRIPT_DIR = join(root, 'tools', 'analyze', 'ghidra');

export interface GhidraFacts {
  language: string;
  functions: { start: number; ranges: [number, number][]; thunk: boolean }[];
  indirect: { addr: number; call: boolean; reg: string; targets: number[] }[];
  data: [number, number][];
}

export interface GhidraRun {
  /** Directory with `<name>.elf` files to analyse. */
  elfDir: string;
  /** Directory with optional `<name>.seeds` files. */
  seedsDir: string;
  /** Receives `<name>.json`. */
  outDir: string;
  workDir: string;
  shards?: number;
  force?: boolean;
  onLog?: (line: string) => void;
}

export function ghidraInstalled(): boolean {
  return existsSync(join(GHIDRA_DIR, 'support', process.platform === 'win32' ? 'analyzeHeadless.bat' : 'analyzeHeadless'));
}

function javaHome(): string {
  return process.env.OOT_JAVA_HOME ?? (existsSync(join(JDK_DIR, 'Contents', 'Home')) ? join(JDK_DIR, 'Contents', 'Home') : JDK_DIR);
}

function runShard(index: number, dir: string, run: GhidraRun, logPath: string): Promise<number> {
  const project = join(tmpdir(), `oot-ghidra-${process.pid}-${index}`);
  rmSync(project, { recursive: true, force: true });
  mkdirSync(project, { recursive: true });
  const args = [
    project, 'oot', '-import', dir, '-deleteProject', '-analysisTimeoutPerFile', '1200',
    '-scriptPath', SCRIPT_DIR,
    '-preScript', 'SeedFunctions.java', run.seedsDir,
    '-postScript', 'ExportFacts.java', run.outDir,
  ];
  const script = join(GHIDRA_DIR, 'support', process.platform === 'win32' ? 'analyzeHeadless.bat' : 'analyzeHeadless');
  const [cmd, cmdArgs] = process.platform === 'win32' ? ['cmd.exe', ['/c', script, ...args]] : [script, args];
  const log = createWriteStream(logPath);
  return new Promise((res, rej) => {
    const p = spawn(cmd, cmdArgs as string[], { env: { ...process.env, JAVA_HOME: javaHome() }, stdio: ['ignore', 'pipe', 'pipe'] });
    const pipe = (d: Buffer) => {
      log.write(d);
      if (run.onLog) for (const l of d.toString().split(/\r?\n/)) if (/ExportFacts: wrote|ERROR/.test(l)) run.onLog(l);
    };
    p.stdout.on('data', pipe);
    p.stderr.on('data', pipe);
    p.on('error', rej);
    p.on('close', (code) => {
      log.end();
      rmSync(project, { recursive: true, force: true });
      res(code ?? 1);
    });
  });
}

/** Analyses every ELF that has no fresh JSON yet. Resolves with the number of programs analysed. */
export async function runGhidra(run: GhidraRun): Promise<number> {
  if (!ghidraInstalled()) throw new Error('Ghidra is not installed: run `npm run analyze:setup` (node tools/analyze/setup.mjs)');
  mkdirSync(run.outDir, { recursive: true });
  const todo = readdirSync(run.elfDir)
    .filter((f) => f.endsWith('.elf'))
    .filter((f) => {
      const out = join(run.outDir, f.replace(/\.elf$/, '.json'));
      if (run.force || !existsSync(out)) return true;
      const seeds = join(run.seedsDir, f.replace(/.elf$/, '.seeds'));
      const inputs = [join(run.elfDir, f), ...(existsSync(seeds) ? [seeds] : [])];
      return inputs.some((i) => statSync(i).mtimeMs > statSync(out).mtimeMs);
    });
  if (!todo.length) return 0;
  const shards = Math.max(1, Math.min(run.shards ?? Math.floor(cpus().length / 2), todo.length, 6));
  const shardRoot = join(run.workDir, 'shards');
  rmSync(shardRoot, { recursive: true, force: true });
  const dirs: string[] = [];
  for (let s = 0; s < shards; s++) {
    const d = join(shardRoot, String(s));
    mkdirSync(d, { recursive: true });
    dirs.push(d);
  }
  // Largest first so the shards finish together.
  todo
    .sort((a, b) => statSync(join(run.elfDir, b)).size - statSync(join(run.elfDir, a)).size)
    .forEach((f, i) => {
      const dst = join(dirs[i % shards]!, f);
      try {
        linkSync(join(run.elfDir, f), dst);
      } catch {
        copyFileSync(join(run.elfDir, f), dst);
      }
    });
  const codes = await Promise.all(dirs.map((d, i) => runShard(i, d, run, join(run.workDir, `ghidra-shard-${i}.log`))));
  rmSync(shardRoot, { recursive: true, force: true });
  const bad = codes.filter((c) => c !== 0).length;
  if (bad) throw new Error(`Ghidra failed in ${bad} of ${shards} shards; see ${run.workDir}/ghidra-shard-*.log`);
  const missing = todo.filter((f) => !existsSync(join(run.outDir, f.replace(/\.elf$/, '.json'))));
  if (missing.length) {
    writeFileSync(join(run.workDir, 'ghidra-missing.txt'), missing.join('\n'));
    throw new Error(`Ghidra produced no output for ${missing.length} images (${missing.slice(0, 3).join(', ')}...)`);
  }
  return todo.length;
}
