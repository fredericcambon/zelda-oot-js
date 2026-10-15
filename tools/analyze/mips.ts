// Minimal MIPS III (VR4300) instruction decoder, written from the VR4300 manual encodings.

export type InsnKind = 'plain' | 'branch' | 'jump' | 'call' | 'jr' | 'jalr' | 'return';

export interface Insn {
  addr: number;
  word: number;
  op: string;
  args: string;
  /** Branch/jump target when statically known. */
  target?: number;
  kind: InsnKind;
  /** The delay slot is annulled when the branch is not taken. */
  likely?: boolean;
  rs: number;
  rt: number;
  rd: number;
  /** Raw 16-bit immediate field. */
  imm: number;
}

export const GPR = [
  'zero', 'at', 'v0', 'v1', 'a0', 'a1', 'a2', 'a3', 't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7',
  's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 't8', 't9', 'k0', 'k1', 'gp', 'sp', 'fp', 'ra',
];

const SPECIAL: Record<number, string> = {
  0x00: 'sll', 0x02: 'srl', 0x03: 'sra', 0x04: 'sllv', 0x06: 'srlv', 0x07: 'srav',
  0x08: 'jr', 0x09: 'jalr', 0x0c: 'syscall', 0x0d: 'break', 0x0f: 'sync',
  0x10: 'mfhi', 0x11: 'mthi', 0x12: 'mflo', 0x13: 'mtlo', 0x14: 'dsllv', 0x16: 'dsrlv', 0x17: 'dsrav',
  0x18: 'mult', 0x19: 'multu', 0x1a: 'div', 0x1b: 'divu', 0x1c: 'dmult', 0x1d: 'dmultu', 0x1e: 'ddiv', 0x1f: 'ddivu',
  0x20: 'add', 0x21: 'addu', 0x22: 'sub', 0x23: 'subu', 0x24: 'and', 0x25: 'or', 0x26: 'xor', 0x27: 'nor',
  0x2a: 'slt', 0x2b: 'sltu', 0x2c: 'dadd', 0x2d: 'daddu', 0x2e: 'dsub', 0x2f: 'dsubu',
  0x30: 'tge', 0x31: 'tgeu', 0x32: 'tlt', 0x33: 'tltu', 0x34: 'teq', 0x36: 'tne',
  0x38: 'dsll', 0x3a: 'dsrl', 0x3b: 'dsra', 0x3c: 'dsll32', 0x3e: 'dsrl32', 0x3f: 'dsra32',
};

const ITYPE: Record<number, string> = {
  0x08: 'addi', 0x09: 'addiu', 0x0a: 'slti', 0x0b: 'sltiu', 0x0c: 'andi', 0x0d: 'ori', 0x0e: 'xori', 0x18: 'daddi', 0x19: 'daddiu',
};
const BRANCH: Record<number, string> = {
  0x04: 'beq', 0x05: 'bne', 0x06: 'blez', 0x07: 'bgtz', 0x14: 'beql', 0x15: 'bnel', 0x16: 'blezl', 0x17: 'bgtzl',
};
const MEM: Record<number, string> = {
  0x1a: 'ldl', 0x1b: 'ldr',
  0x20: 'lb', 0x21: 'lh', 0x22: 'lwl', 0x23: 'lw', 0x24: 'lbu', 0x25: 'lhu', 0x26: 'lwr', 0x27: 'lwu',
  0x28: 'sb', 0x29: 'sh', 0x2a: 'swl', 0x2b: 'sw', 0x2c: 'sdl', 0x2d: 'sdr', 0x2e: 'swr', 0x2f: 'cache',
  0x30: 'll', 0x31: 'lwc1', 0x34: 'lld', 0x35: 'ldc1', 0x37: 'ld',
  0x38: 'sc', 0x39: 'swc1', 0x3c: 'scd', 0x3d: 'sdc1', 0x3f: 'sd',
};
const REGIMM: Record<number, string> = {
  0x00: 'bltz', 0x01: 'bgez', 0x02: 'bltzl', 0x03: 'bgezl', 0x08: 'tgei', 0x09: 'tgeiu', 0x0a: 'tlti', 0x0b: 'tltiu',
  0x0c: 'teqi', 0x0e: 'tnei', 0x10: 'bltzal', 0x11: 'bgezal', 0x12: 'bltzall', 0x13: 'bgezall',
};
const FPU_ARITH: Record<number, string> = {
  0x00: 'add', 0x01: 'sub', 0x02: 'mul', 0x03: 'div', 0x04: 'sqrt', 0x05: 'abs', 0x06: 'mov', 0x07: 'neg',
  0x08: 'round.l', 0x09: 'trunc.l', 0x0a: 'ceil.l', 0x0b: 'floor.l', 0x0c: 'round.w', 0x0d: 'trunc.w', 0x0e: 'ceil.w', 0x0f: 'floor.w',
  0x20: 'cvt.s', 0x21: 'cvt.d', 0x24: 'cvt.w', 0x25: 'cvt.l',
};
const FCMP = ['f', 'un', 'eq', 'ueq', 'olt', 'ult', 'ole', 'ule', 'sf', 'ngle', 'seq', 'ngl', 'lt', 'nge', 'le', 'ngt'];

const hex = (n: number) => '0x' + (n >>> 0).toString(16);
const sx16 = (n: number) => (n << 16) >> 16;

export function decode(word: number, addr: number): Insn {
  word >>>= 0;
  const op = word >>> 26;
  const rs = (word >>> 21) & 31;
  const rt = (word >>> 16) & 31;
  const rd = (word >>> 11) & 31;
  const sa = (word >>> 6) & 31;
  const fn = word & 63;
  const imm = word & 0xffff;
  const base: Insn = { addr, word, op: '.word', args: hex(word), kind: 'plain', rs, rt, rd, imm };
  const r = (n: number) => '$' + GPR[n];
  const set = (o: string, args: string, extra: Partial<Insn> = {}): Insn => ({ ...base, op: o, args, ...extra });

  if (word === 0) return set('nop', '');
  if (op === 0) {
    const name = SPECIAL[fn];
    if (!name) return base;
    if (fn === 0x08) return set('jr', r(rs), { kind: rs === 31 ? 'return' : 'jr' });
    if (fn === 0x09) return set('jalr', `${r(rd)}, ${r(rs)}`, { kind: 'jalr' });
    if (fn === 0x0c || fn === 0x0d || fn === 0x0f) return set(name, '');
    if (fn <= 0x03 || (fn >= 0x38 && fn !== 0x39 && fn !== 0x3d)) return set(name, `${r(rd)}, ${r(rt)}, ${sa}`);
    if (fn === 0x10 || fn === 0x12) return set(name, r(rd));
    if (fn === 0x11 || fn === 0x13) return set(name, r(rs));
    if ((fn >= 0x18 && fn <= 0x1f) || (fn >= 0x30 && fn <= 0x36)) return set(name, `${r(rs)}, ${r(rt)}`);
    if (fn === 0x04 || fn === 0x06 || fn === 0x07 || fn === 0x14 || fn === 0x16 || fn === 0x17) {
      return set(name, `${r(rd)}, ${r(rt)}, ${r(rs)}`);
    }
    return set(name, `${r(rd)}, ${r(rs)}, ${r(rt)}`);
  }
  if (op === 1) {
    const name = REGIMM[rt];
    if (!name) return base;
    if (rt >= 8 && rt <= 0x0e) return set(name, `${r(rs)}, ${sx16(imm)}`);
    const target = (addr + 4 + sx16(imm) * 4) >>> 0;
    return set(name, `${r(rs)}, ${hex(target)}`, {
      kind: rt >= 0x10 ? 'call' : 'branch', target, likely: name.endsWith('l'),
    });
  }
  if (op === 2 || op === 3) {
    const target = ((((addr + 4) & 0xf0000000) | ((word & 0x3ffffff) << 2)) >>> 0);
    return set(op === 2 ? 'j' : 'jal', hex(target), { kind: op === 2 ? 'jump' : 'call', target });
  }
  const bname = BRANCH[op];
  if (bname) {
    const target = (addr + 4 + sx16(imm) * 4) >>> 0;
    const two = op === 4 || op === 5 || op === 0x14 || op === 0x15;
    return set(bname, two ? `${r(rs)}, ${r(rt)}, ${hex(target)}` : `${r(rs)}, ${hex(target)}`, {
      kind: 'branch', target, likely: op >= 0x14,
    });
  }
  if (ITYPE[op]) return set(ITYPE[op], `${r(rt)}, ${r(rs)}, ${op >= 0x0c && op <= 0x0e ? hex(imm) : sx16(imm)}`);
  if (op === 0x0f) return set('lui', `${r(rt)}, ${hex(imm)}`);
  if (MEM[op]) {
    const fp = op === 0x31 || op === 0x39 || op === 0x35 || op === 0x3d;
    const reg = op === 0x2f ? String(rt) : fp ? '$f' + rt : r(rt);
    return set(MEM[op], `${reg}, ${sx16(imm)}(${r(rs)})`);
  }
  if (op === 0x10) {
    if (rs === 0) return set('mfc0', `${r(rt)}, $${rd}`);
    if (rs === 4) return set('mtc0', `${r(rt)}, $${rd}`);
    if (rs === 1) return set('dmfc0', `${r(rt)}, $${rd}`);
    if (rs === 5) return set('dmtc0', `${r(rt)}, $${rd}`);
    if (rs & 0x10) {
      const n: Record<number, string> = { 1: 'tlbr', 2: 'tlbwi', 6: 'tlbwr', 8: 'tlbp', 0x18: 'eret' };
      if (n[fn]) return set(n[fn], '');
    }
    return base;
  }
  if (op === 0x11) {
    if (rs === 0) return set('mfc1', `${r(rt)}, $f${rd}`);
    if (rs === 1) return set('dmfc1', `${r(rt)}, $f${rd}`);
    if (rs === 2) return set('cfc1', `${r(rt)}, $${rd}`);
    if (rs === 4) return set('mtc1', `${r(rt)}, $f${rd}`);
    if (rs === 5) return set('dmtc1', `${r(rt)}, $f${rd}`);
    if (rs === 6) return set('ctc1', `${r(rt)}, $${rd}`);
    if (rs === 8) {
      const target = (addr + 4 + sx16(imm) * 4) >>> 0;
      return set(['bc1f', 'bc1t', 'bc1fl', 'bc1tl'][rt & 3]!, hex(target), {
        kind: 'branch', target, likely: (rt & 2) !== 0,
      });
    }
    const fmt = ({ 16: 's', 17: 'd', 20: 'w', 21: 'l' } as Record<number, string>)[rs];
    if (!fmt) return base;
    if (fn >= 0x30) return set(`c.${FCMP[fn & 15]}.${fmt}`, `$f${rd}, $f${rt}`);
    const name = FPU_ARITH[fn];
    if (!name) return base;
    const unary = (fn >= 4 && fn <= 7) || fn >= 8;
    return set(`${name}.${fmt}`, unary ? `$f${sa}, $f${rd}` : `$f${sa}, $f${rd}, $f${rt}`);
  }
  return base;
}

export function disassemble(buf: Uint8Array, base: number, start = 0, end = buf.length): Insn[] {
  const out: Insn[] = [];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let o = start; o + 4 <= end; o += 4) out.push(decode(dv.getUint32(o), (base + o) >>> 0));
  return out;
}

export function format(i: Insn): string {
  const a = (i.addr >>> 0).toString(16).padStart(8, '0');
  const w = (i.word >>> 0).toString(16).padStart(8, '0');
  return `${a}: ${w}  ${i.op} ${i.args}`.trimEnd();
}
