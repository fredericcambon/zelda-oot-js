// Vitest glue: builds all snippets of a suite with one Emscripten invocation and reports each as a test.
import { join } from 'node:path';
import { ensureToolchain } from './toolchain.ts';
import { beforeAll, describe, it } from 'vitest';
import { check, runSnippets, type Expectation, type Result, type Snippet } from './harness.ts';

let counter = 0;

export function snippetSuite(name: string, snippets: Snippet[]): void {
  const workDir = join(process.cwd(), 'out', 'recomp-test', `${name.replace(/\W+/g, '-')}-${counter++}`);
  describe(name, () => {
    let results: Result[] = [];
    beforeAll(() => {
      results = runSnippets(snippets, ensureToolchain((m) => console.log(m)), workDir);
    }, 1_800_000);
    snippets.forEach((s, i) => {
      it(s.name, () => {
        const errs = check(s, results[i]!);
        if (errs.length > 0) throw new Error(errs.join('\n'));
      });
    });
  });
}

type Extra = Partial<Snippet> & {
  expectMem?: Expectation['mem'];
  trap?: Expectation['trap'];
  events?: Expectation['events'];
  /** Expected FPU registers, FCSR and COP0 registers; `fregs`, `fcsr` and `cop0` set the initial state. */
  expectF?: Expectation['fregs'];
  expectFcsr?: number;
  expectCop0?: Expectation['cop0'];
};

/** A snippet whose assembly is complete, including its returns. */
export function full(name: string, asm: string, init: Snippet['regs'], regs: Expectation['regs'], extra: Extra = {}): Snippet {
  const { expectMem, trap, events, expectF, expectFcsr, expectCop0, ...rest } = extra;
  return { name, asm, regs: init, expect: { regs, mem: expectMem, trap, events, fregs: expectF, fcsr: expectFcsr, cop0: expectCop0 }, ...rest };
}

/** A snippet that gets `jr $ra` and its delay slot appended. */
export function snip(name: string, asm: string, init: Snippet['regs'], regs: Expectation['regs'], extra: Extra = {}): Snippet {
  return full(name, `${asm}\njr $ra\nnop`, init, regs, extra);
}
