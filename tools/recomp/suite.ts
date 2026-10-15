// Vitest glue: builds all snippets of a suite with one Emscripten invocation and reports each as a test.
import { join } from 'node:path';
import { beforeAll, describe, it } from 'vitest';
import { check, findToolchain, runSnippets, type Expectation, type Result, type Snippet } from './harness.ts';

const toolchain = findToolchain();
if (!toolchain) console.warn('recomp snippet suites skipped: Emscripten not found (run `npm run build` once, or set EMSDK)');

let counter = 0;

export function snippetSuite(name: string, snippets: Snippet[]): void {
  const workDir = join(process.cwd(), 'out', 'recomp-test', `${name.replace(/\W+/g, '-')}-${counter++}`);
  describe.skipIf(!toolchain)(name, () => {
    let results: Result[] = [];
    beforeAll(() => {
      results = runSnippets(snippets, toolchain!, workDir);
    }, 300_000);
    snippets.forEach((s, i) => {
      it(s.name, () => {
        const errs = check(s, results[i]!);
        if (errs.length > 0) throw new Error(errs.join('\n'));
      });
    });
  });
}

type Extra = Partial<Snippet> & { expectMem?: Expectation['mem']; trap?: Expectation['trap'] };

/** A snippet whose assembly is complete, including its returns. */
export function full(name: string, asm: string, init: Snippet['regs'], regs: Expectation['regs'], extra: Extra = {}): Snippet {
  const { expectMem, trap, ...rest } = extra;
  return { name, asm, regs: init, expect: { regs, mem: expectMem, trap }, ...rest };
}

/** A snippet that gets `jr $ra` and its delay slot appended. */
export function snip(name: string, asm: string, init: Snippet['regs'], regs: Expectation['regs'], extra: Extra = {}): Snippet {
  return full(name, `${asm}\njr $ra\nnop`, init, regs, extra);
}
