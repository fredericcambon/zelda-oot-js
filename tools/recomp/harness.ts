// Test harness: assembles snippets, recompiles them to C, builds them with Emscripten, runs them in
// Node and returns the final CPU and memory state of each snippet.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assemble, parseReg } from './asm.ts';
import { recompileUnit } from './emit.ts';
import { repoRoot as root, type Toolchain } from './toolchain.ts';


/** Snippets are assembled here; the first function of a snippet is its entry point. */
export const CODE_BASE = 0x80001000;
/** Test data conventionally lives here. */
export const DATA_BASE = 0x80002000;
/** Memory the harness clears and compares, as an offset into RDRAM. */
const WINDOW = 0x10000;

export type RegValue = bigint | number;
export interface MemBytes {
  addr: number;
  bytes: number[];
}
export type TrapName = 'overflow' | 'cond' | 'break' | 'syscall' | 'eret' | 'unimplemented' | 'unmapped';

export interface Expectation {
  /** Registers by name (`t0`, `ra`, `hi`, `lo`). Every other register must keep its initial value. */
  regs?: Record<string, RegValue>;
  /** Bytes that must differ from the initial memory; everything else must stay as it was. */
  mem?: MemBytes[];
  /** FPU registers by name (`f0`..`f31`) as raw bits. Every other register must keep its initial value. */
  fregs?: Record<string, RegValue>;
  fcsr?: number;
  /** COP0 registers by number after the run; every other one must keep its initial value. */
  cop0?: Record<number, RegValue>;
  /** Runtime calls made for TLB and cache instructions, in order: `tlb <op> <pc>` and `cache <op> <addr>`. */
  events?: string[];
  /** The snippet must raise this exception, at `pc` (when given) with `code` (when given). */
  trap?: { kind: TrapName; pc?: number; code?: number };
}

export interface Snippet {
  name: string;
  asm: string;
  regs?: Record<string, RegValue>;
  mem?: MemBytes[];
  /** Initial FPU state: registers as raw bits, FCSR, and the FR bit (default 1, 32-bit pairs when 0). */
  fregs?: Record<string, RegValue>;
  fcsr?: number;
  fr?: 0 | 1;
  /** Initial COP0 register values by number. */
  cop0?: Record<number, RegValue>;
  /** Recompiler inputs of the kind the analysis provides. Labels of the assembly stand for addresses. */
  relocs?: Record<string, number>;
  delta?: number;
  jumpTables?: { site: string; targets: string[] }[];
  expect: Expectation;
}

const toU64 = (v: RegValue) => BigInt.asUintN(64, BigInt(v));

/** Big-endian bytes of 32-bit words stored from `addr`. */
export function words(addr: number, ...vals: number[]): MemBytes {
  return { addr, bytes: vals.flatMap((v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]) };
}
/** Big-endian bytes of 64-bit doublewords stored from `addr`. */
export function dwords(addr: number, ...vals: RegValue[]): MemBytes {
  return {
    addr,
    bytes: vals.flatMap((v) => {
      const u = toU64(v);
      return Array.from({ length: 8 }, (_, k) => Number((u >> BigInt(56 - 8 * k)) & 255n));
    }),
  };
}
export const bytes = (addr: number, ...vals: number[]): MemBytes => ({ addr, bytes: vals });

export interface Result {
  trap?: { kind: TrapName; pc: number; code: number };
  regs: bigint[];
  fregs: bigint[];
  fcsr: number;
  cop0: bigint[];
  events: string[];
  hi: bigint;
  lo: bigint;
  /** Final value, by offset into the window, of every byte that differs from the initial memory. */
  mem: Map<number, number>;
}

const TRAP_KINDS: Record<number, NonNullable<Result['trap']>['kind']> = {
  1: 'overflow', 2: 'cond', 3: 'break', 4: 'syscall', 5: 'eret', [-1]: 'unimplemented', [-2]: 'unmapped',
};

const fprIndex = (name: string) => {
  const m = /^f(\d+)$/.exec(name);
  if (!m || Number(m[1]) > 31) throw new Error(`bad FPU register '${name}'`);
  return Number(m[1]);
};
const hex64 = (v: bigint) => `0x${v.toString(16)}ull`;

function runnerSource(snips: Snippet[], symbols: number[][]): string {
  const out: string[] = [
    '#include "cpu.h"', '#include <stdio.h>', '#include <setjmp.h>', '',
    'uint8_t rdram[RDRAM_SIZE];',
    'static jmp_buf escape;',
    'static int trap_kind;',
    'static uint32_t trap_pc, trap_code;',
    'static int current;',
    'static uint64_t cop0[32];',
    'static char events[4096];',
    'static int nevents;',
    '',
    'uint64_t rt_mfc0(Cpu *c, uint32_t reg) { (void)c; return cop0[reg & 31]; }',
    'void rt_mtc0(Cpu *c, uint32_t reg, uint64_t v) { (void)c; cop0[reg & 31] = v; }',
    'void rt_tlb(Cpu *c, int op, uint32_t pc) { (void)c; nevents += snprintf(events + nevents, sizeof events - nevents, "EV tlb %d %x\\n", op, pc); }',
    'void rt_cache(Cpu *c, uint32_t op, uint32_t addr) { (void)c; nevents += snprintf(events + nevents, sizeof events - nevents, "EV cache %u %x\\n", op, addr); }',
    'void rt_eret(Cpu *c) { (void)c; trap_kind = 5; trap_pc = 0; trap_code = 0; longjmp(escape, 1); }',
    '',
    'void rt_trap(Cpu *c, int kind, uint32_t pc, uint32_t code) { (void)c; trap_kind = kind; trap_pc = pc; trap_code = code; longjmp(escape, 1); }',
    'void rt_unimpl(Cpu *c, uint32_t pc, uint32_t word) { (void)c; trap_kind = -1; trap_pc = pc; trap_code = word; longjmp(escape, 1); }',
    'void rt_sh_overflow(Cpu *c) { (void)c; trap_kind = -2; trap_pc = 0; longjmp(escape, 1); }',
    'void rt_resume_bad(Cpu *c) { (void)c; trap_kind = -2; trap_pc = 0; longjmp(escape, 1); }',
    'void rt_resume_call(Cpu *c, GuestFn fn) { fn(c); }',
    '',
  ];
  snips.forEach((s, i) => {
    out.push(`uint32_t t${i}_delta = ${(s.delta ?? 0) >>> 0}u;`, `#include "case${i}.c"`);
  });
  out.push('', 'void rt_call(Cpu *c, uint32_t addr) {', '  switch (current) {');
  snips.forEach((_, i) => {
    out.push(`  case ${i}:`, '    switch (addr) {');
    for (const a of symbols[i]!) out.push(`    case 0x${a.toString(16)}u: t${i}_fn_${a.toString(16).padStart(8, '0')}(c); return;`);
    out.push('    }', '    break;');
  });
  out.push('  }', '  trap_kind = -2; trap_pc = addr; longjmp(escape, 1);', '}', '');
  out.push(
    'static void dump(int i, Cpu *c, const uint8_t *before) {',
    '  printf("CASE %d %d %x %x\\n", i, trap_kind, trap_pc, trap_code);',
    '  printf("REGS");',
    '  for (int k = 0; k < 32; k++) printf(" %llx", (unsigned long long)c->r[k]);',
    '  printf(" %llx %llx\\n", (unsigned long long)c->hi, (unsigned long long)c->lo);',
    '  printf("FPRS %x", c->fcsr);',
    '  for (int k = 0; k < 32; k++) printf(" %llx", (unsigned long long)c->f[k]);',
    '  printf("\\nCOP0");',
    '  for (int k = 0; k < 32; k++) printf(" %llx", (unsigned long long)cop0[k]);',
    '  printf("\\n%s", events);',
    `  for (uint32_t a = 0; a < ${WINDOW}; a++) if (rdram[a] != before[a]) printf("MEM %x %x\\n", a, rdram[a]);`,
    '}',
    '',
    'int main(void) {',
    `  static uint8_t before[${WINDOW}];`,
    '  Cpu cpu;',
    '  Cpu *c = &cpu;',
  );
  snips.forEach((s, i) => {
    out.push(
      '  {', `    current = ${i}; trap_kind = 0; trap_pc = 0; trap_code = 0;`, '    memset(&cpu, 0, sizeof cpu);',
      '    memset(cop0, 0, sizeof cop0); nevents = 0; events[0] = 0;', `    memset(rdram, 0, ${WINDOW});`,
      `    cpu.fr = ${s.fr ?? 1}; cpu.fcsr = ${s.fcsr ?? 0};`,
    );
    for (const [name, v] of Object.entries(s.fregs ?? {})) out.push(`    cpu.f[${fprIndex(name)}] = ${hex64(toU64(v))};`);
    for (const [n, v] of Object.entries(s.cop0 ?? {})) out.push(`    cop0[${n}] = ${hex64(toU64(v))};`);
    for (const m of s.mem ?? []) {
      if ((m.addr & 0x1fffffff) + m.bytes.length > WINDOW) throw new Error(`${s.name}: memory outside the ${WINDOW}-byte test window`);
      m.bytes.forEach((b, k) => out.push(`    rdram[0x${((m.addr + k) & (WINDOW - 1)).toString(16)}] = ${b};`));
    }
    for (const [name, v] of Object.entries(s.regs ?? {})) {
      if (name === 'hi' || name === 'lo') out.push(`    cpu.${name} = ${hex64(toU64(v))};`);
      else out.push(`    cpu.r[${parseReg('$' + name)}] = ${hex64(toU64(v))};`);
    }
    out.push(
      `    memcpy(before, rdram, ${WINDOW});`,
      '    cpu.r[0] = 0;',
        `    if (setjmp(escape) == 0) t${i}_fn_${CODE_BASE.toString(16)}(c);`,
      `    dump(${i}, c, before);`,
      '  }',
    );
  });
  out.push('  return 0;', '}', '');
  return out.join('\n');
}

export function runSnippets(snips: Snippet[], tc: Toolchain, workDir: string): Result[] {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  const symbols: number[][] = [];
  snips.forEach((s, i) => {
    const { funcs, labels } = assemble(s.asm, CODE_BASE);
    symbols.push(funcs.map((f) => f.addr));
    const symbol = (a: number) => `t${i}_fn_${(a >>> 0).toString(16).padStart(8, '0')}`;
    const addrOf = (l: string) => {
      const a = /^(0x[0-9a-f]+|\d+)$/i.test(l) ? Number(l) : labels.get(l);
      if (a === undefined) throw new Error(`${s.name}: unknown label '${l}'`);
      return a;
    };
    const relocs = new Map(Object.entries(s.relocs ?? {}).map(([l, t]) => [addrOf(l), t]));
    const jumpTables = new Map((s.jumpTables ?? []).map((j) => [addrOf(j.site), j.targets.map(addrOf)]));
    writeFileSync(join(workDir, `case${i}.c`), recompileUnit(funcs, { symbol, relocs, jumpTables, delta: `t${i}_delta` }));
  });
  writeFileSync(join(workDir, 'runner.c'), runnerSource(snips, symbols));

  const build = spawnSync(
    tc.python,
    [tc.emcc, '-O1', '-ffp-contract=off', '-Wall', '-Wno-unused-label', '-Wno-unused-variable', `-I${join(root, 'runtime')}`, '-sENVIRONMENT=node', '-sEXIT_RUNTIME=1', 'runner.c', '-o', 'runner.cjs'],
    { cwd: workDir, env: tc.env, encoding: 'utf8' },
  );
  if (build.status !== 0) throw new Error(`emcc failed:\n${build.stderr}\n${build.stdout}`);
  const run = spawnSync(process.execPath, ['runner.cjs'], { cwd: workDir, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (run.status !== 0) throw new Error(`runner failed (${run.status}):\n${run.stderr}\n${run.stdout.slice(0, 2000)}`);

  const results: Result[] = [];
  for (const line of run.stdout.split('\n')) {
    const t = line.trim().split(' ');
    if (t[0] === 'CASE') {
      const kind = Number(t[2]);
      results.push({
        trap: kind === 0 ? undefined : { kind: TRAP_KINDS[kind]!, pc: parseInt(t[3]!, 16), code: parseInt(t[4]!, 16) },
        regs: [],
        fregs: [],
        fcsr: 0,
        cop0: [],
        events: [],
        hi: 0n,
        lo: 0n,
        mem: new Map(),
      });
    } else if (t[0] === 'REGS') {
      const r = results[results.length - 1]!;
      const vals = t.slice(1).map((h) => BigInt('0x' + h));
      r.regs = vals.slice(0, 32);
      r.hi = vals[32]!;
      r.lo = vals[33]!;
    } else if (t[0] === 'FPRS') {
      const r = results[results.length - 1]!;
      r.fcsr = parseInt(t[1]!, 16);
      r.fregs = t.slice(2).map((h) => BigInt('0x' + h));
    } else if (t[0] === 'COP0') {
      results[results.length - 1]!.cop0 = t.slice(1).map((h) => BigInt('0x' + h));
    } else if (t[0] === 'EV') {
      results[results.length - 1]!.events.push(t.slice(1).join(' '));
    } else if (t[0] === 'MEM') {
      results[results.length - 1]!.mem.set(parseInt(t[1]!, 16), parseInt(t[2]!, 16));
    }
  }
  if (results.length !== snips.length) throw new Error(`runner produced ${results.length} of ${snips.length} results:\n${run.stdout.slice(-500)}`);
  return results;
}

const regIndex = (name: string) => parseReg('$' + name);

/** Differences between a result and the snippet's expectation; empty when it passes. */
export function check(s: Snippet, r: Result): string[] {
  const errs: string[] = [];
  const exp = s.expect;
  const hex = (v: bigint) => '0x' + v.toString(16);

  if (exp.trap) {
    if (r.trap?.kind !== exp.trap.kind) errs.push(`expected trap ${exp.trap.kind}, got ${r.trap?.kind ?? 'none'}`);
    else {
      if (exp.trap.pc !== undefined && r.trap.pc !== exp.trap.pc) errs.push(`trap pc ${hex(BigInt(r.trap.pc))} != ${hex(BigInt(exp.trap.pc))}`);
      if (exp.trap.code !== undefined && r.trap.code !== exp.trap.code) errs.push(`trap code ${r.trap.code} != ${exp.trap.code}`);
    }
  } else if (r.trap) {
    errs.push(`unexpected trap ${r.trap.kind} at ${r.trap.pc.toString(16)} (code ${r.trap.code})`);
  }

  const wantRegs = new Map<number, bigint>();
  let wantHi = toU64(s.regs?.hi ?? 0);
  let wantLo = toU64(s.regs?.lo ?? 0);
  for (let k = 1; k < 32; k++) wantRegs.set(k, 0n);
  for (const [n, v] of Object.entries(s.regs ?? {})) if (n !== 'hi' && n !== 'lo') wantRegs.set(regIndex(n), toU64(v));
  for (const [n, v] of Object.entries(exp.regs ?? {})) {
    if (n === 'hi') wantHi = toU64(v);
    else if (n === 'lo') wantLo = toU64(v);
    else wantRegs.set(regIndex(n), toU64(v));
  }
  wantRegs.set(0, 0n);
  for (const [k, want] of wantRegs) {
    if (r.regs[k] !== want) errs.push(`r${k}: got ${hex(r.regs[k]!)}, want ${hex(want)}`);
  }
  if (r.hi !== wantHi) errs.push(`hi: got ${hex(r.hi)}, want ${hex(wantHi)}`);
  if (r.lo !== wantLo) errs.push(`lo: got ${hex(r.lo)}, want ${hex(wantLo)}`);

  const wantF = new Map<number, bigint>();
  for (let k = 0; k < 32; k++) wantF.set(k, 0n);
  for (const [n, v] of Object.entries(s.fregs ?? {})) wantF.set(fprIndex(n), toU64(v));
  for (const [n, v] of Object.entries(exp.fregs ?? {})) wantF.set(fprIndex(n), toU64(v));
  for (const [k, w] of wantF) if (r.fregs[k] !== w) errs.push(`f${k}: got ${hex(r.fregs[k]!)}, want ${hex(w)}`);
  const wantFcsr = exp.fcsr ?? s.fcsr ?? 0;
  if (r.fcsr !== wantFcsr) errs.push(`fcsr: got 0x${r.fcsr.toString(16)}, want 0x${wantFcsr.toString(16)}`);
  const wantC0 = new Map<number, bigint>();
  for (let k = 0; k < 32; k++) wantC0.set(k, 0n);
  for (const [n, v] of Object.entries(s.cop0 ?? {})) wantC0.set(Number(n), toU64(v));
  for (const [n, v] of Object.entries(exp.cop0 ?? {})) wantC0.set(Number(n), toU64(v));
  for (const [k, w] of wantC0) if (r.cop0[k] !== w) errs.push(`cop0[${k}]: got ${hex(r.cop0[k]!)}, want ${hex(w)}`);
  if (JSON.stringify(r.events) !== JSON.stringify(exp.events ?? [])) errs.push(`events: got ${JSON.stringify(r.events)}, want ${JSON.stringify(exp.events ?? [])}`);

  const want = new Map<number, number>();
  for (const m of [...(s.mem ?? []), ...(exp.mem ?? [])]) m.bytes.forEach((b, k) => want.set((m.addr + k) & (WINDOW - 1), b));
  const got = new Map<number, number>();
  for (const m of s.mem ?? []) m.bytes.forEach((b, k) => got.set((m.addr + k) & (WINDOW - 1), b));
  for (const [a, b] of r.mem) got.set(a, b);
  for (const a of new Set([...want.keys(), ...got.keys()])) {
    const w = want.get(a) ?? 0;
    const g = got.get(a) ?? 0;
    if (w !== g) errs.push(`mem[0x${a.toString(16)}]: got 0x${g.toString(16)}, want 0x${w.toString(16)}`);
  }
  return errs;
}
