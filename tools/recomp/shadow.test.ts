// The shadow stack and resume mode of the generated code: what the emitter produces for each kind of call, the check
// that no C local outlives a call, and a sample program that is run, interrupted at its probes and resumed.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assemble } from './asm.ts';
import { defaultSymbol, liveLocalsAfterCalls, recompileFunction, type CallSite } from './emit.ts';
import { SUSPENDING_ROUTINES } from './generate.ts';
import { ensureToolchain, repoRoot } from './toolchain.ts';

const recompile = (src: string, opts: Parameters<typeof recompileFunction>[1] = {}) =>
  recompileFunction(assemble(src, 0x80001000).funcs[0]!, opts);

describe('call sites in the emitted code', () => {
  it('pushes the key of a direct call before it and pops it after', () => {
    const r = recompile('jal 0x80002000\nnop\njr $ra\nnop', { siteBase: 40 });
    expect(r.sites).toEqual([{ key: 40, addr: 0x80001000 }]);
    expect(r.code).toContain('OOT_PUSH(40); fn_80002000(c); D_40:; OOT_POP();');
    expect(r.code).toContain('Q_40: rt_resume_call(c, fn_80002000); goto D_40;');
    expect(r.code).toContain('case 40: goto Q_40;');
  });

  it('numbers the sites of a function consecutively', () => {
    const r = recompile('jal 0x80002000\nnop\njal 0x80003000\nnop\njalr $t9\nnop\njr $ra\nnop', { siteBase: 7 });
    expect(r.sites).toEqual([
      { key: 7, addr: 0x80001000 }, { key: 8, addr: 0x80001008 }, { key: 9, addr: 0x80001010 },
    ]);
  });

  it('keeps the target of an indirect call out of the resume path', () => {
    const r = recompile('jalr $t9\nnop\njr $ra\nnop');
    expect(r.code).toContain('OOT_PUSH(0); rt_call(c, t); D_0:; OOT_POP();');
    expect(r.code).toContain('Q_0: rt_call(c, 0); goto D_0;');
  });

  it('keeps a frame for a tail call and for the fall into the next function', () => {
    const j = recompile('j 0x80002000\nnop');
    expect(j.code).toContain('{ OOT_PUSH(0); fn_80002000(c); D_0:; OOT_POP(); return; }');
    const fall = recompile('addiu $t0, $t0, 1');
    expect(fall.sites).toEqual([{ key: 0, addr: 0x80001004 }]);
    expect(fall.code).toContain('OOT_PUSH(0); fn_80001004(c); D_0:; OOT_POP();');
  });

  it('keeps a frame for a jr that leaves the function and for a linking branch', () => {
    const jr = recompile('jr $t9\nnop');
    expect(jr.code).toContain('OOT_PUSH(0); rt_call(c, t); D_0:; OOT_POP(); return;');
    const bal = recompile('bgezall $t0, 0x80002000\nnop\njr $ra\nnop');
    expect(bal.code).toContain('OOT_PUSH(0); fn_80002000(c); D_0:; OOT_POP(); }');
  });

  it('gives a jump table one call site: targets in other functions take the default lookup', () => {
    const { funcs, labels } = assemble('site:\njr $t1\nnop\ninside:\njr $ra\nnop\n.func\njr $ra\nnop', 0x80001000);
    const r = recompileFunction(funcs[0]!, { jumpTables: new Map([[labels.get('site')!, [labels.get('inside')!, 0x80001010]]]) });
    expect(r.sites).toHaveLength(1);
    expect(r.code).toContain(`case 0x${labels.get('inside')!.toString(16)}u: goto`);
    expect(r.code).not.toContain('case 0x80001010u');
  });

  it('adds no resume entry to a function that makes no call', () => {
    const r = recompile('addiu $v0, $zero, 1\njr $ra\nnop');
    expect(r.sites).toEqual([]);
    expect(r.code).not.toContain('resume_entry');
    expect(r.code).not.toContain('OOT_RESUMING');
  });

  it('makes every site reachable from the resume entry exactly once', () => {
    const r = recompile('beq $t0, $zero, out\nnop\njal 0x80002000\nnop\nout:\njal 0x80003000\nnop\njalr $t9\nnop\nj 0x80004000\nnop');
    for (const s of r.sites) {
      expect(r.code.match(new RegExp(`case ${s.key}: goto Q_${s.key};`, 'g'))).toHaveLength(1);
      expect(r.code.match(new RegExp(`^\\s*Q_${s.key}:`, 'gm'))).toHaveLength(1);
      expect(r.code.match(new RegExp(`\\bD_${s.key}:`, 'g'))).toHaveLength(1);
    }
    expect(r.sites).toHaveLength(4);
  });
});

describe('calls that cannot suspend the thread', () => {
  const frameless = (a: number) => a === 0x80002000;

  it('make no frame for a direct call, a tail call or the fall into the next function', () => {
    const call = recompile('jal 0x80002000\nnop\njal 0x80003000\nnop\njr $ra\nnop', { frameless });
    expect(call.code).toContain('fn_80002000(c);');
    expect(call.code).not.toContain('PUSH(0); fn_80002000');
    expect(call.sites).toEqual([{ key: 0, addr: 0x80001008 }]);
    expect(call.callees).toEqual([0x80002000, 0x80003000]);
    const tail = recompile('j 0x80002000\nnop', { frameless });
    expect(tail.sites).toEqual([]);
    expect(tail.code).toContain('{ fn_80002000(c); return; }');
    expect(tail.code).not.toContain('resume_entry');
    const fall = recompile('addiu $t0, $t0, 1', { frameless: () => true });
    expect(fall.sites).toEqual([]);
  });

  it('leave an indirect call with its frame', () => {
    const r = recompile('jalr $t9\nnop\njal 0x80002000\nnop\njr $ra\nnop', { frameless: () => true });
    expect(r.indirect).toBe(true);
    expect(r.sites).toEqual([{ key: 0, addr: 0x80001000 }]);
  });

  it('report whether a function calls through the dispatch tables', () => {
    expect(recompile('jal 0x80002000\nnop\njr $ra\nnop').indirect).toBe(false);
    expect(recompile('jr $t9\nnop').indirect).toBe(true);
    expect(recompile('jr $ra\nnop').indirect).toBe(false);
  });

  it('name exactly the routines that the runtime can park a thread in, and the loader that runs recompiled code', () => {
    const sched = readFileSync(join(repoRoot, 'runtime', 'sched.c'), 'utf8');
    const body = /static GuestFn blocking_routine[\s\S]*?return NULL;/.exec(sched)![0];
    const routines = new Set([...body.matchAll(/return rt_(\w+);/g)].map((m) => m[1]!));
    // These two wait through a frame of their own (RT_FRAME_CONT_TRANSFER) around osRecvMesg, and the loader runs recompiled code.
    for (const id of ['overlay_load', 'osContStartReadData', 'osContStartQuery']) routines.add(id);
    expect([...routines].sort()).toEqual([...SUSPENDING_ROUTINES].sort());
  });
});

describe('the check that no C local outlives a call', () => {
  it('accepts a local that is only an argument of the call', () => {
    expect(liveLocalsAfterCalls('{ uint32_t t = c->r[2]; OOT_PUSH(1); rt_call(c, t); D_1:; OOT_POP(); }')).toEqual([]);
  });

  it('rejects a local that is read after the call', () => {
    expect(liveLocalsAfterCalls('{ uint32_t t = c->r[2]; OOT_PUSH(1); f(c); D_1:; OOT_POP(); c->r[3] = t; }')).toEqual(['uses the local t after a call']);
  });

  it('rejects a local of an enclosing block, and one of the function', () => {
    expect(liveLocalsAfterCalls('{ int cnd = 1; { OOT_PUSH(1); f(c); D_1:; OOT_POP(); } if (cnd) c->r[1] = 0; }')).toHaveLength(1);
    expect(liveLocalsAfterCalls('uint64_t x = 1;\nOOT_PUSH(1); f(c); D_1:; OOT_POP();')).toEqual(['declares the function-level local x']);
  });

  it('ignores member names and comments that look like a local', () => {
    expect(liveLocalsAfterCalls('{ uint32_t r = 1; OOT_PUSH(1); f(c); D_1:; OOT_POP(); } /* t0 r */ c->r[3] = 1;')).toEqual([]);
  });

  // Every kind of transfer with every kind of delay slot handling the emitter has; the emitter throws if one keeps a local.
  const KINDS: [string, string][] = [
    ['a call with a delay slot that writes the target register', 'jalr $t9\naddiu $t9, $t9, 4\njr $ra\nnop'],
    ['a call with a delay slot that reads the link register', 'jal 0x80002000\naddu $v0, $ra, $zero\njr $ra\nnop'],
    ['a branch-likely call', 'bgezall $t0, 0x80002000\naddiu $v0, $zero, 1\njr $ra\nnop'],
    ['a call that never links', 'bltzall $t0, 0x80002000\nnop\njr $ra\nnop'],
    ['a linking branch that falls through', 'bgezal $t0, 0x8000100c\nnop\njr $ra\nnop'],
    ['a conditional tail call', 'bne $t0, $t1, 0x80002000\naddiu $v0, $zero, 1\njr $ra\nnop'],
    ['a likely conditional tail call', 'beql $t0, $t1, 0x80002000\naddiu $v0, $zero, 1\njr $ra\nnop'],
    ['a call inside a loop', 'loop:\njal 0x80002000\nnop\nbne $v0, $zero, loop\nnop\njr $ra\nnop'],
    ['a branch to a delay slot', 'beq $t0, $t1, slot\nnop\njal 0x80002000\nslot:\naddiu $v0, $zero, 1\njr $ra\nnop'],
    ['an unconditional branch to another function', 'b 0x80002000\nnop'],
    ['a function that ends in a call', 'jal 0x80002000\nnop'],
    ['a function that ends in a delay slot', 'jal 0x80002000\nlw $v0, 0($t0)'],
    ['a checked add before a call', 'add $t0, $t1, $t2\njal 0x80002000\nnop\nsc $t3, 0($t4)\njr $ra\nnop'],
  ];
  for (const [name, src] of KINDS) {
    it(`holds for ${name}`, () => {
      const r = recompile(src);
      expect(liveLocalsAfterCalls(r.code)).toEqual([]);
    });
  }
});

// ---- A sample program, run and resumed -----------------------------------------------------------------------

const SAMPLE = `
main:
  addiu $sp, $sp, -16
  sw $ra, 0($sp)
  addiu $s0, $zero, 5
callF1:
  jal 0x80001100
  addiu $s1, $zero, 7
  addu $s2, $s0, $s1
  lui $t9, 0x8000
  ori $t9, $t9, 0x1200
callF2:
  jalr $t9
  addiu $s3, $zero, 9
callF4:
  bgezall $s0, 0x80001300
  addiu $s4, $zero, 3
callF5:
  jal 0x80001500
  nop
  addu $s5, $s2, $s3
  sw $s5, 4($sp)
  lw $ra, 0($sp)
  addiu $sp, $sp, 16
  jr $ra
  nop
.org 0x80001100
f1:
  addiu $s6, $zero, 1
tailF3:
  j 0x80001400
  nop
.org 0x80001200
f2:
  addiu $sp, $sp, -16
  sw $ra, 0($sp)
probeF2:
  jal 0x80009000
  nop
  addiu $s7, $s7, 50
  lw $ra, 0($sp)
  jr $ra
  addiu $sp, $sp, 16
.org 0x80001300
f4:
  addiu $sp, $sp, -16
  sw $ra, 0($sp)
probeF4:
  jal 0x80009000
  nop
  addiu $s7, $s7, 7
  lw $ra, 0($sp)
  jr $ra
  addiu $sp, $sp, 16
.org 0x80001400
f3:
  addiu $sp, $sp, -16
  sw $ra, 0($sp)
probeF3:
  jal 0x80009000
  nop
  addiu $s7, $s7, 100
  lw $ra, 0($sp)
  jr $ra
  addiu $sp, $sp, 16
.org 0x80001500
f5:
  addiu $s7, $s7, 1
.func
f6:
  addiu $sp, $sp, -16
  sw $ra, 0($sp)
probeF6:
  jal 0x80009000
  nop
  addiu $s7, $s7, 3
  lw $ra, 0($sp)
  jr $ra
  addiu $sp, $sp, 16
`;

const PROBE = 0x80009000;
const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');

function runnerSource(table: { fn: string; entry: number; site: number }[], addrs: number[]): string {
  return `
#include "dispatch.h"
#include <stdio.h>
#include <stdlib.h>
uint8_t rdram[RDRAM_SIZE];
void rt_trap(Cpu *c, int kind, uint32_t pc, uint32_t code) { (void)c; (void)kind; (void)pc; (void)code; puts("TRAP"); exit(1); }
void rt_unimpl(Cpu *c, uint32_t pc, uint32_t word) { (void)c; (void)pc; (void)word; puts("UNIMPL"); exit(1); }
void rt_missing(Cpu *c, uint32_t addr) { (void)c; printf("MISSING %x\\n", addr); exit(1); }
void rt_sh_overflow(Cpu *c) { (void)c; puts("OVERFLOW"); exit(1); }
void rt_resume_bad(Cpu *c) { (void)c; puts("BAD"); exit(1); }
void rt_resume_call(Cpu *c, GuestFn fn) { fn(c); }
uint64_t rt_mfc0(Cpu *c, uint32_t r) { (void)c; (void)r; return 0; }
void rt_mtc0(Cpu *c, uint32_t r, uint64_t v) { (void)c; (void)r; (void)v; }
void rt_tlb(Cpu *c, int op, uint32_t pc) { (void)c; (void)op; (void)pc; }
void rt_cache(Cpu *c, uint32_t op, uint32_t a) { (void)c; (void)op; (void)a; }
void rt_eret(Cpu *c) { (void)c; exit(1); }
#include "sample.c"
const SiteEntry oot_sites[] = {
${table.map((s) => `  { ${s.fn}, 0x${hex(s.entry)}u, 0x${hex(s.site)}u },`).join('\n')}
};
const uint32_t oot_site_count = ${table.length};

void rt_call(Cpu *c, uint32_t addr) {
  if (c->resume) { oot_sites[c->sh[c->rpos]].fn(c); return; }
  switch (addr) {
${addrs.map((a) => `  case 0x${hex(a)}u: ${defaultSymbol(a)}(c); return;`).join('\n')}
  }
  rt_missing(c, addr);
}

#define WINDOW 0x10000
static Cpu snap_cpu[8];
static uint8_t snap_mem[8][WINDOW];
static int nsnap, replaying;

void rt_probe(Cpu *c) {
  if (c->resume) {
    if (c->rpos != c->shn) { puts("CHAIN LEFT OVER"); exit(1); }
    c->resume = 0;
    return;
  }
  if (replaying) return;
  printf("PROBE %d", nsnap);
  for (uint32_t k = 0; k < c->shn; k++) printf(" %u", c->sh[k]);
  printf("\\n");
  snap_cpu[nsnap] = *c;
  memcpy(snap_mem[nsnap], rdram, WINDOW);
  nsnap++;
}

int main(void) {
  static Cpu c, replay, done;
  static uint8_t done_mem[WINDOW];
  c.r[29] = SX32(0x80003000);
  fn_80001000(&c);
  printf("DEPTH %u\\n", c.shn);
  done = c;
  memcpy(done_mem, rdram, WINDOW);
  replaying = 1;
  for (int k = 0; k < nsnap; k++) {
    replay = snap_cpu[k];
    memcpy(rdram, snap_mem[k], WINDOW);
    replay.resume = 1;
    replay.rpos = 0;
    oot_sites[replay.sh[0]].fn(&replay);
    int same = memcmp(replay.r, done.r, sizeof replay.r) == 0 && memcmp(rdram, done_mem, WINDOW) == 0 && replay.shn == 0 && replay.resume == 0;
    printf("REPLAY %d %s\\n", k, same ? "same" : "different");
  }
  return 0;
}
`;
}

describe('a sample program with every kind of call', () => {
  const { funcs, labels } = assemble(SAMPLE, 0x80001000);
  const table: { fn: string; entry: number; site: number }[] = [];
  const parts: string[] = [];
  const callees = new Set<number>();
  const keyOf = new Map<string, number>();
  const callee = (a: number) => (a === PROBE ? 'rt_probe' : defaultSymbol(a));
  for (const f of funcs) {
    const r = recompileFunction(f, { siteBase: table.length, callee });
    parts.push(r.code);
    r.callees.forEach((a) => callees.add(a));
    r.sites.forEach((s: CallSite) => {
      keyOf.set(`${hex(f.addr)}/${hex(s.addr)}`, s.key);
      table.push({ fn: r.name, entry: f.addr, site: s.addr });
    });
  }
  const decls = [...callees].map((a) => `void ${callee(a)}(Cpu *c);`);
  const sample = ['#include "cpu.h"', ...decls, ...parts].join('\n');

  const dir = join(repoRoot, 'out', 'recomp-test', 'shadow');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sample.c'), sample);
  writeFileSync(join(dir, 'runner.c'), runnerSource(table, funcs.map((f) => f.addr)));
  const tc = ensureToolchain();
  const build = spawnSync(
    tc.python,
    [tc.emcc, '-O1', '-ffp-contract=off', '-Wall', '-Wno-unused-label', '-Wno-unused-variable', `-I${join(repoRoot, 'runtime')}`, '-sENVIRONMENT=node', '-sEXIT_RUNTIME=1', 'runner.c', '-o', 'runner.cjs'],
    { cwd: dir, env: tc.env, encoding: 'utf8' },
  );
  if (build.status !== 0) throw new Error(`emcc failed:\n${build.stderr}`);
  const run = spawnSync(process.execPath, ['runner.cjs'], { cwd: dir, encoding: 'utf8' });
  const lines = run.stdout.split('\n').filter((l) => l !== '');

  const site = (fn: string, call: string) => keyOf.get(`${hex(labels.get(fn)!)}/${hex(labels.get(call)!)}`)!;
  const probes = lines.filter((l) => l.startsWith('PROBE')).map((l) => l.split(' ').slice(2).map(Number));

  it('runs to the end with an empty shadow stack', () => {
    expect(run.status, run.stderr).toBe(0);
    expect(lines).toContain('DEPTH 0');
  });

  it('holds a frame for each active call at every probe', () => {
    expect(probes).toEqual([
      // main called f1 directly, f1 tail-called f3, f3 called the probe
      [site('main', 'callF1'), site('f1', 'tailF3'), site('f3', 'probeF3')],
      // main called f2 through a register
      [site('main', 'callF2'), site('f2', 'probeF2')],
      // main called f4 with a linking branch
      [site('main', 'callF4'), site('f4', 'probeF4')],
      // main called f5, which falls into f6
      [site('main', 'callF5'), site('f5', 'f6'), site('f6', 'probeF6')],
    ]);
  });

  it('describes the frames as the functions and call addresses they stand for', () => {
    const [direct, indirect] = probes.map((keys) => keys.map((k) => table[k]!));
    expect(direct).toEqual([
      { fn: 'fn_80001000', entry: 0x80001000, site: labels.get('callF1') },
      { fn: 'fn_80001100', entry: 0x80001100, site: labels.get('tailF3') },
      { fn: 'fn_80001400', entry: 0x80001400, site: labels.get('probeF3') },
    ]);
    expect(indirect![0]).toEqual({ fn: 'fn_80001000', entry: 0x80001000, site: labels.get('callF2') });
  });

  it('rebuilds the chain of every probe from its keys and the registers alone, and ends in the same state', () => {
    const replays = lines.filter((l) => l.startsWith('REPLAY'));
    expect(replays).toEqual(['REPLAY 0 same', 'REPLAY 1 same', 'REPLAY 2 same', 'REPLAY 3 same']);
  });
});
