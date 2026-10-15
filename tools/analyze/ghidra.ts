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

const BATCH_SIZE = 12;
/** Wall-clock limit for one batch; Ghidra is killed past it and the batch's missing images are reported. */
const BATCH_TIMEOUT_MS = 40 * 60 * 1000;

function runBatch(index: number, dir: string, run: GhidraRun, logPath: string): Promise<number> {
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
    const timer = setTimeout(() => {
      log.write('\nbatch timed out\n');
      // A .bat wrapper leaves the JVM running after cmd.exe is killed; kill the whole tree.
      if (process.platform === 'win32' && p.pid) spawn('taskkill', ['/pid', String(p.pid), '/t', '/f'], { stdio: 'ignore' });
      else p.kill('SIGKILL');
    }, BATCH_TIMEOUT_MS);
    const pipe = (d: Buffer) => log.write(d);
    p.stdout.on('data', pipe);
    p.stderr.on('data', pipe);
    p.on('error', (e) => {
      clearTimeout(timer);
      rej(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      log.end();
      rmSync(project, { recursive: true, force: true });
      res(code ?? 1);
    });
  });
}

/** Analyses every ELF that has no fresh JSON yet, in small batches. Resolves with the number of programs analysed. */
export async function runGhidra(run: GhidraRun): Promise<number> {
  if (!ghidraInstalled()) throw new Error('Ghidra is not installed: run `npm run analyze:setup` (node tools/analyze/setup.mjs)');
  mkdirSync(run.outDir, { recursive: true });
  const todo = readdirSync(run.elfDir)
    .filter((f) => f.endsWith('.elf'))
    .filter((f) => {
      const out = join(run.outDir, f.replace(/.elf$/, '.json'));
      if (run.force || !existsSync(out)) return true;
      const seeds = join(run.seedsDir, f.replace(/.elf$/, '.seeds'));
      const inputs = [join(run.elfDir, f), ...(existsSync(seeds) ? [seeds] : [])];
      return inputs.some((i) => statSync(i).mtimeMs > statSync(out).mtimeMs);
    });
  if (!todo.length) return 0;
  const workers = Math.max(1, Math.min(run.shards ?? Math.floor(cpus().length / 2), 6));
  const batchRoot = join(run.workDir, 'batches');
  rmSync(batchRoot, { recursive: true, force: true });
  // Largest first so the long files start early; each batch mixes sizes.
  const sorted = todo.sort((a, b) => statSync(join(run.elfDir, b)).size - statSync(join(run.elfDir, a)).size);
  const nBatches = Math.ceil(sorted.length / BATCH_SIZE);
  const batches: string[][] = Array.from({ length: nBatches }, () => []);
  sorted.forEach((f, i) => batches[i % nBatches]!.push(f));
  let finished = 0;
  const runPass = async (passBatches: string[][], concurrency: number): Promise<string[]> => {
    let next = 0;
    const failed: string[] = [];
    const worker = async (w: number) => {
      for (;;) {
        const b = next++;
        if (b >= passBatches.length) return;
        const dir = join(batchRoot, String(w));
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        for (const f of passBatches[b]!) {
          try {
            linkSync(join(run.elfDir, f), join(dir, f));
          } catch {
            copyFileSync(join(run.elfDir, f), join(dir, f));
          }
        }
        const t0 = Date.now();
        const code = await runBatch(w, dir, run, join(run.workDir, `ghidra-batch-${w}.log`));
        const missing = passBatches[b]!.filter((f) => !existsSync(join(run.outDir, f.replace(/.elf$/, '.json'))));
        failed.push(...missing);
        rmSync(dir, { recursive: true, force: true });
        finished++;
        run.onLog?.(`ghidra batch ${finished}/${passBatches.length}: ${passBatches[b]!.length - missing.length}/${passBatches[b]!.length} images in ${Math.round((Date.now() - t0) / 1000)}s${code !== 0 ? ` (exit ${code})` : ''}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, passBatches.length) }, (_, w) => worker(w)));
    return failed;
  };
  let failed = await runPass(batches, workers);
  if (failed.length) {
    // Parallel JVM starts occasionally fail to read the shared language files; one image at a time is reliable.
    run.onLog?.(`retrying ${failed.length} images one by one`);
    failed = await runPass(failed.map((f) => [f]), 1);
  }
  rmSync(batchRoot, { recursive: true, force: true });
  if (failed.length) {
    writeFileSync(join(run.workDir, 'ghidra-missing.txt'), failed.join('\n'));
    throw new Error(`Ghidra produced no output for ${failed.length} images (${failed.slice(0, 3).join(', ')}...); see ${run.workDir}/ghidra-batch-*.log`);
  }
  return todo.length;
}
