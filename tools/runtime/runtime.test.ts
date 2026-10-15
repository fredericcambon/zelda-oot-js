// Builds the runtime's C unit tests (runtime/tests) with Emscripten, runs them in Node and reports each C test
// as one test of this file. The tests use no ROM.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureToolchain, repoRoot } from '../recomp/toolchain.ts';

const runtimeDir = join(repoRoot, 'runtime');
const sources = [
  ...readdirSync(runtimeDir).filter((f) => f.endsWith('.c') && f !== 'main.c').map((f) => join(runtimeDir, f)),
  ...readdirSync(join(runtimeDir, 'tests')).filter((f) => f.endsWith('.c')).map((f) => join(runtimeDir, 'tests', f)),
];

function buildAndRun(): { results: Map<string, string>; stderr: string } {
  const tc = ensureToolchain();
  const work = resolve(repoRoot, 'out', 'runtime-test');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const build = spawnSync(
    tc.python,
    [
      tc.emcc, '-O1', '-Wall', '-Wextra', '-Wno-unused-parameter', '-ffp-contract=off', `-I${runtimeDir}`,
      '-sASYNCIFY', '-sENVIRONMENT=node', '-sEXIT_RUNTIME=1', '-sALLOW_MEMORY_GROWTH=1', '-sINITIAL_MEMORY=64MB', '-sSTACK_SIZE=1MB',
      ...sources, '-o', 'tests.cjs',
    ],
    { cwd: work, env: tc.env, encoding: 'utf8' },
  );
  if (build.status !== 0) throw new Error(`emcc failed:\n${build.stderr}\n${build.stdout}`);
  if (/warning:/.test(build.stderr)) throw new Error(`runtime compiles with warnings:\n${build.stderr}`);
  const run = spawnSync(process.execPath, ['tests.cjs'], { cwd: work, encoding: 'utf8', maxBuffer: 1 << 26, timeout: 100_000 });
  const results = new Map<string, string>();
  for (const line of run.stdout.split('\n')) {
    const m = /^(PASS|FAIL) (\S+)\s*(.*)$/.exec(line.trim());
    if (m) results.set(m[2]!, m[1] === 'PASS' ? '' : m[3]!);
  }
  return { results, stderr: run.stderr };
}

const { results, stderr } = buildAndRun();

describe('runtime unit tests', () => {
  it('ran every test', () => {
    expect(results.size, stderr).toBeGreaterThan(40);
  });
  for (const [name, failure] of results) {
    it(name, () => {
      expect(failure).toBe('');
    });
  }
});
