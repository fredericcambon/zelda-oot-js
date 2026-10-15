// MIPS III integer ISA to C. Each function becomes `void name(Cpu *c)`; see runtime/cpu.h.
import { decode, format, type Insn } from '../analyze/mips.ts';

export interface FuncInput {
  addr: number;
  /** Instruction words, including the delay slot of a trailing branch. */
  words: number[];
}

export interface EmitOptions {
  /** C identifier of the recompiled function at a guest address. */
  symbol?: (addr: number) => string;
}

export const defaultSymbol = (addr: number) => `fn_${(addr >>> 0).toString(16).padStart(8, '0')}`;

const hex8 = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
const sx16 = (n: number) => (n << 16) >> 16;

const U = (n: number) => (n === 0 ? '0ull' : `c->r[${n}]`);
const S64 = (n: number) => `(int64_t)${U(n)}`;
const U32 = (n: number) => `(uint32_t)${U(n)}`;
const S32 = (n: number) => `(int32_t)${U(n)}`;
const SX = (expr: string) => `SX32(${expr})`;

function set(n: number, expr: string): string {
  return n === 0 ? `(void)(${expr});` : `c->r[${n}] = ${expr};`;
}

// Branch conditions on the registers' values before the delay slot runs.
const CONDITIONS: Record<string, (i: Insn) => string> = {
  beq: (i) => `${U(i.rs)} == ${U(i.rt)}`,
  bne: (i) => `${U(i.rs)} != ${U(i.rt)}`,
  blez: (i) => `${S64(i.rs)} <= 0`,
  bgtz: (i) => `${S64(i.rs)} > 0`,
  bltz: (i) => `${S64(i.rs)} < 0`,
  bgez: (i) => `${S64(i.rs)} >= 0`,
};
const BRANCH_BASE: Record<string, string> = {
  beql: 'beq', bnel: 'bne', blezl: 'blez', bgtzl: 'bgtz', bltzl: 'bltz', bgezl: 'bgez',
  bltzal: 'bltz', bgezal: 'bgez', bltzall: 'bltz', bgezall: 'bgez',
};

const TRAP_REG: Record<string, (i: Insn) => string> = {
  tge: (i) => `${S64(i.rs)} >= ${S64(i.rt)}`,
  tgeu: (i) => `${U(i.rs)} >= ${U(i.rt)}`,
  tlt: (i) => `${S64(i.rs)} < ${S64(i.rt)}`,
  tltu: (i) => `${U(i.rs)} < ${U(i.rt)}`,
  teq: (i) => `${U(i.rs)} == ${U(i.rt)}`,
  tne: (i) => `${U(i.rs)} != ${U(i.rt)}`,
};
const TRAP_IMM: Record<string, (i: Insn) => string> = {
  tgei: (i) => `${S64(i.rs)} >= ${sx16(i.imm)}ll`,
  tgeiu: (i) => `${U(i.rs)} >= (uint64_t)${sx16(i.imm)}ll`,
  tlti: (i) => `${S64(i.rs)} < ${sx16(i.imm)}ll`,
  tltiu: (i) => `${U(i.rs)} < (uint64_t)${sx16(i.imm)}ll`,
  teqi: (i) => `${U(i.rs)} == (uint64_t)${sx16(i.imm)}ll`,
  tnei: (i) => `${U(i.rs)} != (uint64_t)${sx16(i.imm)}ll`,
};

const LOADS: Record<string, (a: string) => string> = {
  lb: (a) => `(uint64_t)(int64_t)(int8_t)rd8(${a})`,
  lbu: (a) => `(uint64_t)rd8(${a})`,
  lh: (a) => `(uint64_t)(int64_t)(int16_t)rd16(${a})`,
  lhu: (a) => `(uint64_t)rd16(${a})`,
  lw: (a) => SX(`rd32(${a})`),
  lwu: (a) => `(uint64_t)rd32(${a})`,
  ld: (a) => `rd64(${a})`,
};

function addrExpr(i: Insn): string {
  return `(uint32_t)(${U32(i.rs)} + ${sx16(i.imm) >>> 0}u)`;
}

/** Overflow-checked add/sub: the destination is untouched when the exception is raised. */
function checked(dest: number, op: 'add' | 'sub', bits: 32 | 64, a: string, b: string, pc: number): string {
  const t = bits === 32 ? 'int32_t' : 'int64_t';
  const res = bits === 32 ? SX('r') : '(uint64_t)r';
  return `{ ${t} r; if (__builtin_${op}_overflow(${a}, ${b}, &r)) rt_trap(c, TRAP_OVERFLOW, 0x${hex8(pc)}u, 0); ${set(dest, res)} }`;
}

function plain(i: Insn): string {
  const { rs, rt, rd } = i;
  const sa = (i.word >>> 6) & 31;
  const simm = sx16(i.imm);
  const pc = i.addr;
  const imm = i.imm;
  switch (i.op) {
    case 'nop': case 'sync': case 'cache': return ';';
    case 'sll': return set(rd, SX(`${U32(rt)} << ${sa}`));
    case 'srl': return set(rd, SX(`${U32(rt)} >> ${sa}`));
    case 'sra': return set(rd, SX(`${S32(rt)} >> ${sa}`));
    case 'sllv': return set(rd, SX(`${U32(rt)} << (${U(rs)} & 31)`));
    case 'srlv': return set(rd, SX(`${U32(rt)} >> (${U(rs)} & 31)`));
    case 'srav': return set(rd, SX(`${S32(rt)} >> (${U(rs)} & 31)`));
    case 'dsll': return set(rd, `${U(rt)} << ${sa}`);
    case 'dsrl': return set(rd, `${U(rt)} >> ${sa}`);
    case 'dsra': return set(rd, `(uint64_t)(${S64(rt)} >> ${sa})`);
    case 'dsll32': return set(rd, `${U(rt)} << ${sa + 32}`);
    case 'dsrl32': return set(rd, `${U(rt)} >> ${sa + 32}`);
    case 'dsra32': return set(rd, `(uint64_t)(${S64(rt)} >> ${sa + 32})`);
    case 'dsllv': return set(rd, `${U(rt)} << (${U(rs)} & 63)`);
    case 'dsrlv': return set(rd, `${U(rt)} >> (${U(rs)} & 63)`);
    case 'dsrav': return set(rd, `(uint64_t)(${S64(rt)} >> (${U(rs)} & 63))`);
    case 'mfhi': return set(rd, 'c->hi');
    case 'mflo': return set(rd, 'c->lo');
    case 'mthi': return `c->hi = ${U(rs)};`;
    case 'mtlo': return `c->lo = ${U(rs)};`;
    case 'mult': return `mult32(c, ${S32(rs)}, ${S32(rt)});`;
    case 'multu': return `multu32(c, ${U32(rs)}, ${U32(rt)});`;
    case 'div': return `div32(c, ${S32(rs)}, ${S32(rt)});`;
    case 'divu': return `divu32(c, ${U32(rs)}, ${U32(rt)});`;
    case 'dmult': return `dmult64(c, ${S64(rs)}, ${S64(rt)});`;
    case 'dmultu': return `dmultu64(c, ${U(rs)}, ${U(rt)});`;
    case 'ddiv': return `ddiv64(c, ${S64(rs)}, ${S64(rt)});`;
    case 'ddivu': return `ddivu64(c, ${U(rs)}, ${U(rt)});`;
    case 'add': return checked(rd, 'add', 32, S32(rs), S32(rt), pc);
    case 'sub': return checked(rd, 'sub', 32, S32(rs), S32(rt), pc);
    case 'dadd': return checked(rd, 'add', 64, S64(rs), S64(rt), pc);
    case 'dsub': return checked(rd, 'sub', 64, S64(rs), S64(rt), pc);
    case 'addu': return set(rd, SX(`${U32(rs)} + ${U32(rt)}`));
    case 'subu': return set(rd, SX(`${U32(rs)} - ${U32(rt)}`));
    case 'daddu': return set(rd, `${U(rs)} + ${U(rt)}`);
    case 'dsubu': return set(rd, `${U(rs)} - ${U(rt)}`);
    case 'and': return set(rd, `${U(rs)} & ${U(rt)}`);
    case 'or': return set(rd, `${U(rs)} | ${U(rt)}`);
    case 'xor': return set(rd, `${U(rs)} ^ ${U(rt)}`);
    case 'nor': return set(rd, `~(${U(rs)} | ${U(rt)})`);
    case 'slt': return set(rd, `(uint64_t)(${S64(rs)} < ${S64(rt)})`);
    case 'sltu': return set(rd, `(uint64_t)(${U(rs)} < ${U(rt)})`);
    case 'addi': return checked(rt, 'add', 32, S32(rs), `${simm}`, pc);
    case 'daddi': return checked(rt, 'add', 64, S64(rs), `${simm}ll`, pc);
    case 'addiu': return set(rt, SX(`${U32(rs)} + ${simm >>> 0}u`));
    case 'daddiu': return set(rt, `${U(rs)} + (uint64_t)${simm}ll`);
    case 'slti': return set(rt, `(uint64_t)(${S64(rs)} < ${simm}ll)`);
    case 'sltiu': return set(rt, `(uint64_t)(${U(rs)} < (uint64_t)${simm}ll)`);
    case 'andi': return set(rt, `${U(rs)} & ${imm}ull`);
    case 'ori': return set(rt, `${U(rs)} | ${imm}ull`);
    case 'xori': return set(rt, `${U(rs)} ^ ${imm}ull`);
    case 'lui': return set(rt, SX(`${imm << 16 >>> 0}u`));
    case 'lwl': return set(rt, `lwl(${U(rt)}, ${addrExpr(i)})`);
    case 'lwr': return set(rt, `lwr(${U(rt)}, ${addrExpr(i)})`);
    case 'ldl': return set(rt, `ldl(${U(rt)}, ${addrExpr(i)})`);
    case 'ldr': return set(rt, `ldr(${U(rt)}, ${addrExpr(i)})`);
    case 'sb': return `wr8(${addrExpr(i)}, (uint8_t)${U(rt)});`;
    case 'sh': return `wr16(${addrExpr(i)}, (uint16_t)${U(rt)});`;
    case 'sw': return `wr32(${addrExpr(i)}, ${U32(rt)});`;
    case 'sd': return `wr64(${addrExpr(i)}, ${U(rt)});`;
    case 'swl': return `swl(${U32(rt)}, ${addrExpr(i)});`;
    case 'swr': return `swr(${U32(rt)}, ${addrExpr(i)});`;
    case 'sdl': return `sdl(${U(rt)}, ${addrExpr(i)});`;
    case 'sdr': return `sdr(${U(rt)}, ${addrExpr(i)});`;
    case 'll': return `{ uint32_t a = ${addrExpr(i)}; c->llbit = 1; ${set(rt, SX('rd32(a)'))} }`;
    case 'lld': return `{ uint32_t a = ${addrExpr(i)}; c->llbit = 1; ${set(rt, 'rd64(a)')} }`;
    case 'sc': return `{ uint32_t a = ${addrExpr(i)}; uint64_t ok = c->llbit; if (ok) wr32(a, ${U32(rt)}); c->llbit = 0; ${set(rt, 'ok')} }`;
    case 'scd': return `{ uint32_t a = ${addrExpr(i)}; uint64_t ok = c->llbit; if (ok) wr64(a, ${U(rt)}); c->llbit = 0; ${set(rt, 'ok')} }`;
    case 'syscall': return `rt_trap(c, TRAP_SYSCALL, 0x${hex8(pc)}u, ${(i.word >>> 6) & 0xfffff});`;
    case 'break': return `rt_trap(c, TRAP_BREAK, 0x${hex8(pc)}u, ${(i.word >>> 6) & 0xfffff});`;
  }
  const load = LOADS[i.op];
  if (load) return set(rt, load(addrExpr(i)));
  const tr = TRAP_REG[i.op];
  if (tr) return `if (${tr(i)}) rt_trap(c, TRAP_COND, 0x${hex8(pc)}u, ${(i.word >>> 6) & 0x3ff});`;
  const ti = TRAP_IMM[i.op];
  if (ti) return `if (${ti(i)}) rt_trap(c, TRAP_COND, 0x${hex8(pc)}u, 0);`;
  return `rt_unimpl(c, 0x${hex8(pc)}u, 0x${hex8(i.word)}u);`;
}

const isControl = (i: Insn) => i.kind !== 'plain';

interface Ctx {
  start: number;
  end: number;
  symbol: (addr: number) => string;
  labels: Set<number>;
  callees: Set<number>;
}

const inside = (x: Ctx, addr: number) => addr >= x.start && addr < x.end;
const label = (addr: number) => `L_${hex8(addr)}`;

/** Control-transfer code for the branch `i`, with its delay slot `slot` folded in. */
function branch(x: Ctx, i: Insn, slot: Insn): string {
  const pc = i.addr;
  const next = pc + 8;
  const slotCode = plain(slot);
  const link = `c->r[31] = 0x${hex8(next)}u;`;
  const callTo = (t: number) => {
    x.callees.add(t);
    return `${x.symbol(t)}(c);`;
  };
  // A transfer to another function is a tail call.
  const goTo = (t: number) => {
    if (inside(x, t)) return `goto ${label(t)};`;
    return `{ ${callTo(t)} return; }`;
  };

  switch (i.kind) {
    case 'return': return `{ ${slotCode} return; }`;
    case 'jr': return `{ uint32_t t = ${U32(i.rs)}; ${slotCode} rt_call(c, t); return; }`;
    case 'jalr':
      return `{ uint32_t t = ${U32(i.rs)}; ${i.rd === 0 ? '' : `c->r[${i.rd}] = 0x${hex8(next)}u;`} ${slotCode} rt_call(c, t); }`;
    case 'jump': return `{ ${slotCode} ${goTo(i.target!)} }`;
    case 'call':
      if (i.op === 'jal') return `{ ${link} ${slotCode} ${callTo(i.target!)} }`;
      break;
  }

  const base = BRANCH_BASE[i.op] ?? i.op;
  const cond = CONDITIONS[base]!(i);
  const likely = i.likely === true;
  const linking = i.op.endsWith('al') || i.op.endsWith('all');
  const t = i.target!;
  const taken = linking ? (t === next ? ';' : callTo(t)) : goTo(t);
  const always = !linking && (base === 'beq' ? i.rs === i.rt : false);
  const lk = linking ? link : '';
  if (likely) return `{ int cnd = ${cond}; ${lk} if (cnd) { ${slotCode} ${taken} } }`;
  if (always) return `{ ${slotCode} ${taken} }`;
  return `{ int cnd = ${cond}; ${lk} ${slotCode} if (cnd) { ${taken} } }`;
}

/** Whether execution can never continue past the branch to the next instruction. */
function terminates(i: Insn): boolean {
  if (i.kind === 'return' || i.kind === 'jr' || i.kind === 'jump') return true;
  return i.op === 'beq' && i.rs === i.rt;
}

export interface Recompiled {
  name: string;
  code: string;
  /** Guest addresses of the functions this one calls or tail-calls. */
  callees: number[];
}

export function recompileFunction(f: FuncInput, opts: EmitOptions = {}): Recompiled {
  const symbol = opts.symbol ?? defaultSymbol;
  const insns = f.words.map((w, k) => decode(w, (f.addr + 4 * k) >>> 0));
  const x: Ctx = { start: f.addr, end: f.addr + 4 * insns.length, symbol, labels: new Set(), callees: new Set() };

  // A delay slot never holds a branch, so index k+1 after a control insn is always its slot.
  for (let k = 0; k < insns.length; k++) {
    const i = insns[k]!;
    if (!isControl(i)) continue;
    if (k + 1 >= insns.length) throw new Error(`${hex8(i.addr)}: branch without a delay slot`);
    if (isControl(insns[k + 1]!)) throw new Error(`${hex8(i.addr)}: branch in a delay slot`);
    if (i.target !== undefined && inside(x, i.target) && i.kind !== 'call') x.labels.add(i.target);
    k++;
  }

  const body: string[] = [];
  let last: Insn | undefined;
  for (let k = 0; k < insns.length; k++) {
    const i = insns[k]!;
    const emitLabel = (a: number) => {
      if (x.labels.has(a)) body.push(`${label(a)}:;`);
    };
    emitLabel(i.addr);
    body.push(`  /* ${format(i)} */`);
    if (!isControl(i)) {
      body.push(`  ${plain(i)}`);
      last = i;
      continue;
    }
    const slot = insns[k + 1]!;
    body.push(`  ${branch(x, i, slot)}`);
    body.push(`  /* ${format(slot)} (delay slot) */`);
    if (x.labels.has(slot.addr)) {
      // The slot is also a jump target: give it a standalone copy that the branch path skips.
      x.labels.add(slot.addr + 4);
      body.push(`  goto ${label(slot.addr + 4)};`, `${label(slot.addr)}:;`, `  ${plain(slot)}`);
    }
    last = i;
    k++;
  }
  if (x.labels.has(x.end)) body.push(`${label(x.end)}:;`);
  if (last === undefined || !terminates(last)) {
    x.callees.add(x.end);
    body.push(`  ${symbol(x.end)}(c);`);
  }

  const name = symbol(f.addr);
  return {
    name,
    code: `void ${name}(Cpu *c) {\n${body.join('\n')}\n}\n`,
    callees: [...x.callees].sort((a, b) => a - b),
  };
}

/** C translation unit for a set of functions, with declarations for every callee. */
export function recompileUnit(funcs: FuncInput[], opts: EmitOptions = {}): string {
  const symbol = opts.symbol ?? defaultSymbol;
  const results = funcs.map((f) => recompileFunction(f, opts));
  const callees = new Set(results.flatMap((r) => r.callees));
  const decls = [...callees].sort((a, b) => a - b).map((a) => `void ${symbol(a)}(Cpu *c);`);
  return ['#include "cpu.h"', '', ...decls, '', ...results.map((r) => r.code)].join('\n');
}
