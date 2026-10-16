// Disassembler for the RSP's instruction set (documented at n64brew.dev): the scalar MIPS subset plus COP0, COP2 moves and the
// vector loads, stores and computations. Used to read the audio microcode that the game ships in its code file.
const R = ['zero', 'at', 'v0', 'v1', 'a0', 'a1', 'a2', 'a3', 't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 't8', 't9', 'k0', 'k1', 'gp', 'sp', 'fp', 'ra'];
const reg = (n: number) => '$' + R[n];
const vr = (n: number) => '$v' + n;
const hex = (n: number) => '0x' + (n >>> 0).toString(16);
const s16 = (n: number) => (n << 16) >> 16;

const VECTOR_OPS: Record<number, string> = {
  0x00: 'vmulf', 0x01: 'vmulu', 0x02: 'vrndp', 0x03: 'vmulq', 0x04: 'vmudl', 0x05: 'vmudm', 0x06: 'vmudn', 0x07: 'vmudh',
  0x08: 'vmacf', 0x09: 'vmacu', 0x0a: 'vrndn', 0x0b: 'vmacq', 0x0c: 'vmadl', 0x0d: 'vmadm', 0x0e: 'vmadn', 0x0f: 'vmadh',
  0x10: 'vadd', 0x11: 'vsub', 0x13: 'vabs', 0x14: 'vaddc', 0x15: 'vsubc', 0x1d: 'vsar',
  0x20: 'vlt', 0x21: 'veq', 0x22: 'vne', 0x23: 'vge', 0x24: 'vcl', 0x25: 'vch', 0x26: 'vcr', 0x27: 'vmrg',
  0x28: 'vand', 0x29: 'vnand', 0x2a: 'vor', 0x2b: 'vnor', 0x2c: 'vxor', 0x2d: 'vnxor',
  0x30: 'vrcp', 0x31: 'vrcpl', 0x32: 'vrcph', 0x33: 'vmov', 0x34: 'vrsq', 0x35: 'vrsql', 0x36: 'vrsqh', 0x37: 'vnop',
};
const LOADS = ['lbv', 'lsv', 'llv', 'ldv', 'lqv', 'lrv', 'lpv', 'luv', 'lhv', 'lfv', 'lwv', 'ltv'];
const STORES = ['sbv', 'ssv', 'slv', 'sdv', 'sqv', 'srv', 'spv', 'suv', 'shv', 'sfv', 'swv', 'stv'];
/** Bytes that one unit of a vector load or store's offset field covers, by instruction (`lbv`, `lsv`, ..., `ltv`). */
export const LOAD_STORE_SCALE = [1, 2, 4, 8, 16, 16, 8, 8, 16, 8, 16, 16];

export function disassembleRsp(w: number, pc: number): string {
  const op = w >>> 26, rs = (w >>> 21) & 31, rt = (w >>> 16) & 31, rd = (w >>> 11) & 31, sa = (w >>> 6) & 31, fn = w & 63;
  const imm = w & 0xffff;
  const target = (pc + 4 + (s16(imm) << 2)) & 0xfff;
  const mem = `${s16(imm)}(${reg(rs)})`;
  switch (op) {
    case 0: {
      const names: Record<number, string> = { 0x20: 'add', 0x21: 'addu', 0x22: 'sub', 0x23: 'subu', 0x24: 'and', 0x25: 'or', 0x26: 'xor', 0x27: 'nor', 0x2a: 'slt', 0x2b: 'sltu' };
      if (w === 0) return 'nop';
      if (fn === 0) return `sll ${reg(rd)}, ${reg(rt)}, ${sa}`;
      if (fn === 2) return `srl ${reg(rd)}, ${reg(rt)}, ${sa}`;
      if (fn === 3) return `sra ${reg(rd)}, ${reg(rt)}, ${sa}`;
      if (fn === 4) return `sllv ${reg(rd)}, ${reg(rt)}, ${reg(rs)}`;
      if (fn === 6) return `srlv ${reg(rd)}, ${reg(rt)}, ${reg(rs)}`;
      if (fn === 7) return `srav ${reg(rd)}, ${reg(rt)}, ${reg(rs)}`;
      if (fn === 8) return `jr ${reg(rs)}`;
      if (fn === 9) return `jalr ${reg(rd)}, ${reg(rs)}`;
      if (fn === 13) return 'break';
      if (names[fn]) return `${names[fn]} ${reg(rd)}, ${reg(rs)}, ${reg(rt)}`;
      return `.word ${hex(w)}`;
    }
    case 1: return `${['bltz', 'bgez'][rt] ?? (rt === 16 ? 'bltzal' : rt === 17 ? 'bgezal' : '?')} ${reg(rs)}, ${hex(target)}`;
    case 2: return `j ${hex((w & 0x3ff) << 2)}`;
    case 3: return `jal ${hex((w & 0x3ff) << 2)}`;
    case 4: return `beq ${reg(rs)}, ${reg(rt)}, ${hex(target)}`;
    case 5: return `bne ${reg(rs)}, ${reg(rt)}, ${hex(target)}`;
    case 6: return `blez ${reg(rs)}, ${hex(target)}`;
    case 7: return `bgtz ${reg(rs)}, ${hex(target)}`;
    case 8: case 9: return `addi${op === 9 ? 'u' : ''} ${reg(rt)}, ${reg(rs)}, ${s16(imm)}`;
    case 10: return `slti ${reg(rt)}, ${reg(rs)}, ${s16(imm)}`;
    case 11: return `sltiu ${reg(rt)}, ${reg(rs)}, ${s16(imm)}`;
    case 12: return `andi ${reg(rt)}, ${reg(rs)}, ${hex(imm)}`;
    case 13: return `ori ${reg(rt)}, ${reg(rs)}, ${hex(imm)}`;
    case 14: return `xori ${reg(rt)}, ${reg(rs)}, ${hex(imm)}`;
    case 15: return `lui ${reg(rt)}, ${hex(imm)}`;
    case 16: return rs === 0 ? `mfc0 ${reg(rt)}, c0r${rd}` : rs === 4 ? `mtc0 ${reg(rt)}, c0r${rd}` : `.word ${hex(w)}`;
    case 18: {
      if (w & (1 << 25)) return `${VECTOR_OPS[fn] ?? `v?${hex(fn)}`} ${vr(sa)}, ${vr(rd)}, ${vr(rt)}[e=${rs & 15}]`;
      const el = (w >>> 7) & 15;
      if (rs === 0) return `mfc2 ${reg(rt)}, ${vr(rd)}[${el}]`;
      if (rs === 2) return `cfc2 ${reg(rt)}, c2r${rd}`;
      if (rs === 4) return `mtc2 ${reg(rt)}, ${vr(rd)}[${el}]`;
      if (rs === 6) return `ctc2 ${reg(rt)}, c2r${rd}`;
      return `.word ${hex(w)}`;
    }
    case 32: return `lb ${reg(rt)}, ${mem}`;
    case 33: return `lh ${reg(rt)}, ${mem}`;
    case 35: return `lw ${reg(rt)}, ${mem}`;
    case 36: return `lbu ${reg(rt)}, ${mem}`;
    case 37: return `lhu ${reg(rt)}, ${mem}`;
    case 39: return `lwu ${reg(rt)}, ${mem}`;
    case 40: return `sb ${reg(rt)}, ${mem}`;
    case 41: return `sh ${reg(rt)}, ${mem}`;
    case 43: return `sw ${reg(rt)}, ${mem}`;
    case 50: case 58: {
      const sub = (w >>> 11) & 31, el = (w >>> 7) & 15, off = ((w & 0x7f) << 25) >> 25;
      const names = op === 50 ? LOADS : STORES;
      const name = names[sub];
      return name ? `${name} ${vr(rt)}[${el}], ${off * LOAD_STORE_SCALE[sub]!}(${reg(rs)})` : `.word ${hex(w)}`;
    }
    default: return `.word ${hex(w)}`;
  }
}

export function disassembleRspRange(bytes: Uint8Array, base: number): string[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: string[] = [];
  for (let o = 0; o + 4 <= bytes.length; o += 4) {
    const w = dv.getUint32(o);
    out.push(`${hex(base + o).slice(2).padStart(4, '0')}: ${w.toString(16).padStart(8, '0')}  ${disassembleRsp(w, base + o)}`);
  }
  return out;
}
