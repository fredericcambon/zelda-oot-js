// Straight-line constant propagation over decoded MIPS, enough to read call arguments built with lui/ori/addiu.

import { decode, type Insn } from './mips.ts';

const STORES = new Set(['sb', 'sh', 'sw', 'sd', 'swl', 'swr', 'sdl', 'sdr', 'swc1', 'sdc1', 'sc', 'scd', 'cache', 'nop']);
const NO_GPR_WRITE = new Set(['mtc1', 'dmtc1', 'ctc1', 'mtc0', 'dmtc0', 'mthi', 'mtlo', 'mult', 'multu', 'div', 'divu', 'syscall', 'break', 'sync']);
const I_TYPE_DEST_RT = new Set([
  'addi', 'addiu', 'slti', 'sltiu', 'andi', 'ori', 'xori', 'daddi', 'daddiu', 'lui',
  'lb', 'lh', 'lwl', 'lw', 'lbu', 'lhu', 'lwr', 'lwu', 'ld', 'ldl', 'ldr', 'll', 'lld',
  'mfc0', 'dmfc0', 'mfc1', 'dmfc1', 'cfc1',
]);

/** GPR written by an instruction, or -1 when it writes none we track. */
export function gprWritten(i: Insn): number {
  if (STORES.has(i.op) || NO_GPR_WRITE.has(i.op) || i.kind === 'branch' || i.kind === 'jump' || i.kind === 'jr' || i.kind === 'return') return -1;
  if (i.kind === 'call') return 31;
  if (i.kind === 'jalr') return i.rd;
  if (I_TYPE_DEST_RT.has(i.op)) return i.rt;
  if (i.word >>> 26 === 0) return i.rd;
  return -1;
}

export type Regs = Array<number | undefined>;

/** Applies one instruction to the register state. Unknown results clear the destination. */
export function step(regs: Regs, i: Insn): void {
  const rs = regs[i.rs];
  const rt = regs[i.rt];
  const simm = (i.imm << 16) >> 16;
  let v: number | undefined;
  switch (i.op) {
    case 'lui': v = (i.imm << 16) >>> 0; break;
    case 'ori': v = rs === undefined ? undefined : (rs | i.imm) >>> 0; break;
    case 'andi': v = rs === undefined ? undefined : (rs & i.imm) >>> 0; break;
    case 'addiu': case 'addi': v = rs === undefined ? undefined : (rs + simm) >>> 0; break;
    case 'addu': case 'add': v = rs === undefined || rt === undefined ? undefined : (rs + rt) >>> 0; break;
    case 'subu': case 'sub': v = rs === undefined || rt === undefined ? undefined : (rs - rt) >>> 0; break;
    case 'or': v = rs === undefined || rt === undefined ? undefined : (rs | rt) >>> 0; break;
    case 'sll': v = rt === undefined ? undefined : (rt << ((i.word >>> 6) & 31)) >>> 0; break;
    default: {
      const d = gprWritten(i);
      if (d > 0) regs[d] = undefined;
      return;
    }
  }
  const d = I_TYPE_DEST_RT.has(i.op) ? i.rt : i.rd;
  if (d > 0) regs[d] = v;
}

export function freshRegs(): Regs {
  const r: Regs = new Array<number | undefined>(32).fill(undefined);
  r[0] = 0;
  return r;
}

/**
 * Register values at the moment control reaches the target of the call/jump at `idx`: runs the straight-line
 * run of instructions before it (back to the previous control transfer) and the delay slot.
 */
export function regsAtCall(insns: Insn[], idx: number): Regs {
  let start = idx;
  while (start > 0) {
    const prev = insns[start - 1]!;
    if (prev.kind !== 'plain') break;
    start--;
  }
  const regs = freshRegs();
  for (let k = start; k <= Math.min(idx + 1, insns.length - 1); k++) {
    if (k === idx) continue;
    step(regs, insns[k]!);
  }
  return regs;
}

export function decodeAt(buf: Uint8Array, base: number, off: number): Insn {
  return decode(new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(off), (base + off) >>> 0);
}
