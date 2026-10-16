import { describe, expect, it } from 'vitest';
import { disassembleRsp } from './rspdis.ts';
import { RspReference } from './rsp-ref.ts';

// Encoders for the instruction forms the programs below use.
const r = (fn: number, rs: number, rt: number, rd: number, sa = 0) => ((rs << 21) | (rt << 16) | (rd << 11) | (sa << 6) | fn) >>> 0;
const i = (op: number, rs: number, rt: number, imm: number) => ((op << 26) | (rs << 21) | (rt << 16) | (imm & 0xffff)) >>> 0;
const addi = (rt: number, rs: number, imm: number) => i(8, rs, rt, imm);
const ori = (rt: number, rs: number, imm: number) => i(13, rs, rt, imm);
const sw = (rt: number, base: number, off: number) => i(43, base, rt, off);
const beq = (rs: number, rt: number, off: number) => i(4, rs, rt, off);
const mtc0 = (rt: number, rd: number) => ((16 << 26) | (4 << 21) | (rt << 16) | (rd << 11)) >>> 0;
const BREAK = 0x0d;
const vec = (fn: number, vd: number, vs: number, vt: number, e = 0) => ((0x12 << 26) | (1 << 25) | (e << 21) | (vt << 16) | (vs << 11) | (vd << 6) | fn) >>> 0;
const vmem = (store: boolean, sub: number, vt: number, base: number, off: number, e = 0) => (((store ? 0x3a : 0x32) << 26) | (base << 21) | (vt << 16) | (sub << 11) | (e << 7) | (off & 0x7f)) >>> 0;
const LQV = 4, LRV = 5, SQV = 4, SDV = 3, SSV = 1;

// Registers: $t0..$t3 are 8..11.
const T0 = 8, T1 = 9, T2 = 10, T3 = 11;

function program(words: readonly number[]): Uint8Array {
  const code = new Uint8Array(0x1000);
  const dv = new DataView(code.buffer);
  words.forEach((w, k) => dv.setUint32(k * 4, w));
  return code;
}

/** Runs `words` on a reference whose RAM holds `ram` and returns it and the working memory. */
function run(words: readonly number[], ram: Uint8Array = new Uint8Array(0x1000)) {
  const ref = new RspReference(program(words));
  ref.run(ram, { dataPtr: 0, dataSize: 0, listPtr: 0, listSize: 0 });
  const dv = new DataView(ref.dmem.buffer);
  return { ref, dv, ram };
}

/** Instructions that DMA `bytes` from RAM `ramAddr` to working memory `dmemAddr`. */
const dmaIn = (dmemAddr: number, ramAddr: number, bytes: number) => [
  ori(T0, 0, dmemAddr), mtc0(T0, 0), ori(T0, 0, ramAddr), mtc0(T0, 1), ori(T0, 0, bytes - 1), mtc0(T0, 2),
];
/** Instructions that DMA `bytes` from working memory `dmemAddr` to RAM `ramAddr`. */
const dmaOut = (dmemAddr: number, ramAddr: number, bytes: number) => [
  ori(T0, 0, dmemAddr), mtc0(T0, 0), ori(T0, 0, ramAddr), mtc0(T0, 1), ori(T0, 0, bytes - 1), mtc0(T0, 3),
];

function ramWith(values: readonly number[], at = 0x100): Uint8Array {
  const ram = new Uint8Array(0x1000);
  const dv = new DataView(ram.buffer);
  values.forEach((v, k) => dv.setInt16(at + k * 2, v));
  return ram;
}

describe('scalar instructions', () => {
  it('runs the instruction after a taken branch before the branch lands', () => {
    const { dv } = run([
      addi(T0, 0, 1),
      beq(0, 0, 2),
      addi(T1, 0, 5),
      addi(T0, 0, 9),
      sw(T0, 0, 0x100),
      sw(T1, 0, 0x104),
      BREAK,
    ]);
    expect(dv.getUint32(0x100)).toBe(1);
    expect(dv.getUint32(0x104)).toBe(5);
  });

  it('writes the return address with jal and returns with jr', () => {
    const { dv } = run([
      (3 << 26) | (0x10 >> 2),
      addi(T0, 0, 3),
      sw(T0, 0, 0x100),
      BREAK,
      sw(31, 0, 0x104),
      r(8, 31, 0, 0),
      0,
    ]);
    expect(dv.getUint32(0x104)).toBe(0x08);
    expect(dv.getUint32(0x100)).toBe(3);
  });
});

describe('DMA', () => {
  it('copies RAM to the working memory and back in whole 8-byte units', () => {
    const ram = ramWith([1, 2, 3, 4, 5, 6, 7, 8]);
    const out = run([...dmaIn(0x200, 0x100, 16), ...dmaOut(0x200, 0x300, 16), BREAK], ram);
    expect(Array.from(out.ram.subarray(0x300, 0x310))).toEqual(Array.from(ram.subarray(0x100, 0x110)));
    expect(out.dv.getInt16(0x200 + 14)).toBe(8);
  });
});

const lanes = (dv: DataView, at: number, n = 8) => Array.from({ length: n }, (_, k) => dv.getInt16(at + k * 2));

describe('vector instructions', () => {
  /** Loads v1 and v2 from RAM words at 0x100 and 0x110, runs `body`, stores v3 at 0x200. */
  const binary = (a: readonly number[], b: readonly number[], body: readonly number[]) =>
    lanes(run([
      ...dmaIn(0x100, 0x100, 32), vmem(false, LQV, 1, 0, 0x100 >> 4), vmem(false, LQV, 2, 0, 0x110 >> 4),
      ...body, vmem(true, SQV, 3, 0, 0x200 >> 4), BREAK,
    ], ramWith([...a, ...b])).dv, 0x200);

  it('multiplies with rounding and saturation (vmulf)', () => {
    const out = binary([0x4000, -0x4000, 0x7fff, -0x8000, 1, 0, 0x2000, 3], [0x4000, 0x4000, 0x7fff, -0x8000, 1, 5, -0x4000, -0x4000], [vec(0, 3, 1, 2)]);
    // (a * b * 2 + 0x8000) >> 16, saturated: -0x8000 squared overflows to 0x7fff.
    expect(out).toEqual([0x2000, -0x2000, 0x7ffe, 0x7fff, 0, 0, -0x1000, -1]);
  });

  it('broadcasts one lane of the second operand when asked', () => {
    const out = binary([1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000], [0x4000, 0, 0, 0, 0, 0, 0, 0], [vec(0, 3, 1, 2, 8)]);
    expect(out).toEqual([500, 1000, 1500, 2000, 2500, 3000, 3500, 4000]);
  });

  it('adds with saturation (vadd)', () => {
    const out = binary([30000, -30000, 1, 2, 3, 4, 5, 6], [10000, -10000, 1, 2, 3, 4, 5, 6], [vec(0x10, 3, 1, 2)]);
    expect(out.slice(0, 4)).toEqual([32767, -32768, 2, 4]);
  });

  it('forms a 32-bit product from the high and low halves and reads the accumulator with vsar', () => {
    // vmudh leaves 0x1234 * 0x0100 << 16 in the accumulator: high part 0x12, middle part 0x3400.
    const middle = binary([0x1234, 0, 0, 0, 0, 0, 0, 0], [0x0100, 0, 0, 0, 0, 0, 0, 0], [vec(7, 0, 1, 2), vec(0x1d, 3, 0, 0, 9)]);
    const high = binary([0x1234, 0, 0, 0, 0, 0, 0, 0], [0x0100, 0, 0, 0, 0, 0, 0, 0], [vec(7, 0, 1, 2), vec(0x1d, 3, 0, 0, 8)]);
    expect(middle[0]).toBe(0x3400);
    expect(high[0]).toBe(0x12);
  });

  it('loads and stores partial vectors (lrv, sdv, ssv)', () => {
    const ram = ramWith([11, 12, 13, 14, 15, 16, 17, 18]);
    const { dv } = run([
      ...dmaIn(0x100, 0x100, 16),
      addi(T1, 0, 0x108),
      addi(T2, 0, 0x250),
      addi(T3, 0, 0x240),
      // lrv fills the right end of the register with the bytes before the address (the first four samples).
      vmem(false, LRV, 4, T1, 0),
      vmem(true, SDV, 4, T3, 0, 8),
      vmem(false, LQV, 1, 0, 0x100 >> 4),
      vmem(true, SSV, 1, T2, 0, 4),
      BREAK,
    ], ram);
    expect(lanes(dv, 0x240, 4)).toEqual([11, 12, 13, 14]);
    expect(dv.getInt16(0x250)).toBe(13);
  });
});

describe('the disassembler', () => {
  it('names scalar, memory and vector instructions', () => {
    expect(disassembleRsp(addi(T0, 0, 1), 0)).toBe('addi $t0, $zero, 1');
    expect(disassembleRsp(sw(T0, 29, 4), 0)).toBe('sw $t0, 4($sp)');
    expect(disassembleRsp(vec(0, 3, 1, 2, 8), 0)).toBe('vmulf $v3, $v1, $v2[e=8]');
    expect(disassembleRsp(vmem(false, LQV, 1, 0, 2), 0)).toBe('lqv $v1[0], 32($zero)');
    expect(disassembleRsp(BREAK, 0)).toBe('break');
  });
});
