// Per-function behavioural features used by the OS recognition rules.

import { freshRegs, step } from './constprop.ts';
import type { Code } from './discover.ts';
import type { InvFunction } from './types.ts';

export interface FunctionFeatures {
  start: number;
  /** Number of instructions in the function body. */
  insns: number;
  /** Physical or KSEG address of hardware registers touched through constant addresses (uncached form). */
  hw: number[];
  /** COP0 register numbers read (mfc0) and written (mtc0). */
  cop0Read: number[];
  cop0Write: number[];
  /** `cache` operation codes used. */
  cacheOps: number[];
  /** Counts of special instructions. */
  special: Record<string, number>;
  /** Constant addresses in cached/uncached RAM that the code dereferences. */
  globals: number[];
  calls: number[];
  /** Number of loops (backward branches). */
  backBranches: number;
  /** Whether any `jr` other than a return ends a path. */
  indirectJumps: number;
  stores: number;
  loads: number;
}

const MEM = /^(l[bhwd]u?|lwl|lwr|ldl|ldr|lwu|s[bhwd]|swl|swr|sdl|sdr|lwc1|swc1|ldc1|sdc1|ll|sc)$/;
const SPECIAL = new Set(['eret', 'tlbwi', 'tlbwr', 'tlbr', 'tlbp', 'syscall', 'break', 'sync', 'll', 'sc']);

export function isHardware(addr: number): boolean {
  const a = addr >>> 0;
  return (a >= 0xa3f00000 && a < 0xa5000000) || (a >= 0xbfc00000 && a < 0xbfc00800);
}

export function extractFeatures(code: Code, f: InvFunction, visited: Iterable<number>): FunctionFeatures {
  const out: FunctionFeatures = {
    start: f.start, insns: 0, hw: [], cop0Read: [], cop0Write: [], cacheOps: [], special: {}, globals: [], calls: f.calls,
    backBranches: 0, indirectJumps: 0, stores: 0, loads: 0,
  };
  const hw = new Set<number>();
  const globals = new Set<number>();
  const read = new Set<number>();
  const write = new Set<number>();
  const cache = new Set<number>();
  let regs = freshRegs();
  let clear = false;
  for (const a of [...visited].sort((x, y) => x - y)) {
    const i = code.at(a);
    out.insns++;
    const sx = (i.imm << 16) >> 16;
    const base = regs[i.rs];
    if (MEM.test(i.op)) {
      if (i.op.startsWith('s')) out.stores++;
      else out.loads++;
      if (base !== undefined) {
        const ea = (base + sx) >>> 0;
        if (isHardware(ea)) hw.add(ea);
        else if (ea >= 0x80000000 && ea < 0xa0000000) globals.add(ea);
      }
    }
    if (i.op === 'cache') cache.add(i.rt);
    if (i.op === 'mfc0' || i.op === 'dmfc0') read.add(i.rd);
    if (i.op === 'mtc0' || i.op === 'dmtc0') write.add(i.rd);
    if (SPECIAL.has(i.op)) out.special[i.op] = (out.special[i.op] ?? 0) + 1;
    if (i.kind === 'branch' && i.target !== undefined && i.target <= i.addr) out.backBranches++;
    if (i.kind === 'jr') out.indirectJumps++;
    step(regs, i);
    // A register that holds a hardware base address and is used in an immediate computation is also a use.
    if ((i.op === 'addiu' || i.op === 'ori') && regs[i.rt] !== undefined && isHardware(regs[i.rt]!)) hw.add(regs[i.rt]!);
    if (clear) {
      regs = freshRegs();
      clear = false;
    }
    if (i.kind === 'call' || i.kind === 'jalr' || i.kind === 'jump' || i.kind === 'jr' || i.kind === 'return') clear = true;
  }
  out.hw = [...hw].sort((x, y) => x - y);
  out.globals = [...globals].sort((x, y) => x - y);
  out.cop0Read = [...read].sort((x, y) => x - y);
  out.cop0Write = [...write].sort((x, y) => x - y);
  out.cacheOps = [...cache].sort((x, y) => x - y);
  return out;
}
