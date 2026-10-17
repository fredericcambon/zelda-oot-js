// Reference execution of the graphics microcode, used only by tests and by the notes' verification runs: it executes the
// microcode text the game ships (boot microcode, then the microcode it loads) on a display list and returns what the RSP
// computes and what it sends to the RDP, so that the display-list interpreter's formulas (`runtime/gfx/dl.c`) can be compared with
// the real thing. It implements the RSP instruction set as documented at n64brew.dev (scalar subset, COP0 DMA and display
// processor registers, vector unit); nothing in the shipped game runs it.
import { LOAD_STORE_SCALE } from '../audio/rspdis.ts';

const DMEM_MASK = 0xfff;
const s16 = (n: number) => (n << 16) >> 16;
const u16 = (n: number) => n & 0xffff;

/** A range of RDP command bytes the microcode handed to the display processor. */
export interface RdpChunk {
  /** True when the commands were read from the working memory (XBUS), else from RAM. */
  xbus: boolean;
  bytes: Uint8Array;
}

/** The task record as the OS leaves it in the top of the working memory (64 bytes at `0xFC0`). */
export const TASK_RECORD_BYTES = 0x40;

/** Reciprocal and reciprocal square root tables of the vector unit's divide unit (512 entries each), per n64brew.dev. */
const RECIPROCALS = Uint16Array.from({ length: 512 }, (_, i) => (i === 0 ? 0xffff : Number(((1n << 34n) / BigInt(i + 512) + 1n) >> 8n) & 0xffff));
const INVERSE_SQUARE_ROOTS = Uint16Array.from({ length: 512 }, (_, i) => {
  const a = BigInt((i + 512) >> (i % 2 === 1 ? 1 : 0));
  let b = 1n << 17n;
  while (a * (b + 1n) * (b + 1n) < 1n << 44n) b++;
  // The two smallest odd-index entries overflow 16 bits (a * b^2 reaches 2^44 only at b = 2^17); they saturate.
  return Number(b >> 1n) > 0xffff + 0x10000 - 1 ? 0xffff : Number(b >> 1n);
});

const BROADCAST: number[][] = [
  [0, 1, 2, 3, 4, 5, 6, 7], [0, 1, 2, 3, 4, 5, 6, 7], [0, 0, 2, 2, 4, 4, 6, 6], [1, 1, 3, 3, 5, 5, 7, 7],
  [0, 0, 0, 0, 4, 4, 4, 4], [1, 1, 1, 1, 5, 5, 5, 5], [2, 2, 2, 2, 6, 6, 6, 6], [3, 3, 3, 3, 7, 7, 7, 7],
  ...Array.from({ length: 8 }, (_, k) => new Array<number>(8).fill(k)),
];

export class GfxMicrocodeRef {
  readonly dmem = new Uint8Array(0x1000);
  readonly imem = new Uint8Array(0x1000);
  readonly rdp: RdpChunk[] = [];
  /** Words of every vector register, big-endian bytes. */
  readonly v = Array.from({ length: 32 }, () => new Uint8Array(16));
  readonly r = new Uint32Array(32);
  private acc = new Array<number>(8).fill(0);
  private vco = 0;
  private vcc = 0;
  private vce = 0;
  private divIn = 0;
  private divOut = 0;
  private divDp = false;
  private c0 = new Uint32Array(16);
  private semaphore = 0;
  private status = 1;
  private dpStatus = 0;
  private ram: Uint8Array = new Uint8Array(0);
  private branchTarget: number | null = null;
  private halted = false;
  /** Instructions executed by the last run. */
  steps = 0;
  /** Called with the program counter before each instruction, for tracing. */
  trace?: (pc: number, word: number) => void;

  private rb(a: number) { return this.dmem[a & DMEM_MASK]!; }
  private rh(a: number) { return (this.rb(a) << 8) | this.rb(a + 1); }
  private rw(a: number) { return ((this.rb(a) << 24) | (this.rb(a + 1) << 16) | (this.rb(a + 2) << 8) | this.rb(a + 3)) >>> 0; }
  private wb(a: number, x: number) { this.dmem[a & DMEM_MASK] = x & 0xff; }
  private wh(a: number, x: number) { this.wb(a, x >> 8); this.wb(a + 1, x); }
  private ww(a: number, x: number) { this.wh(a, x >>> 16); this.wh(a + 2, x & 0xffff); }

  lane(reg: number, i: number) { const b = this.v[reg]!; return s16((b[i * 2]! << 8) | b[i * 2 + 1]!); }
  setLane(reg: number, i: number, x: number) { const b = this.v[reg]!; b[i * 2] = (x >> 8) & 0xff; b[i * 2 + 1] = x & 0xff; }

  /**
   * Runs the task the way the console does: the boot microcode goes to the start of the instruction memory, the task
   * record to the top of the working memory, and execution starts at the boot microcode. `ram` is the guest memory
   * indexed by physical address; the microcode's DMA reads and writes it.
   */
  runTask(ram: Uint8Array, taskAddr: number, maxSteps = 20_000_000): void {
    this.ram = ram;
    const task = taskAddr & 0x7fffff;
    const dv = new DataView(ram.buffer, ram.byteOffset, ram.byteLength);
    const boot = dv.getUint32(task + 0x08) & 0x7fffff, bootSize = dv.getUint32(task + 0x0c);
    this.imem.set(ram.subarray(boot, boot + bootSize));
    this.dmem.set(ram.subarray(task, task + TASK_RECORD_BYTES), 0xfc0);
    this.halted = false;
    this.status = 0;
    this.rdp.length = 0;
    let pc = 0;
    let steps = 0;
    for (; steps < maxSteps && !this.halted; steps++) {
      const word = this.fetch(pc);
      this.trace?.(pc, word);
      this.step(word, pc);
      if (this.branchTarget !== null) {
        const target = this.branchTarget;
        this.branchTarget = null;
        this.step(this.fetch((pc + 4) & 0xfff), (pc + 4) & 0xfff);
        pc = target;
      } else {
        pc = (pc + 4) & 0xfff;
      }
    }
    this.steps = steps;
    if (!this.halted) throw new Error(`microcode did not halt in ${maxSteps} steps (pc 0x${pc.toString(16)})`);
  }

  private fetch(pc: number): number {
    const i = pc & 0xffc;
    return ((this.imem[i]! << 24) | (this.imem[i + 1]! << 16) | (this.imem[i + 2]! << 8) | this.imem[i + 3]!) >>> 0;
  }

  private reg(n: number) { return n === 0 ? 0 : this.r[n]!; }
  private setReg(n: number, x: number) { if (n !== 0) this.r[n] = x >>> 0; }

  private dma(read: boolean): void {
    const spec = this.c0[read ? 2 : 3]!;
    const length = (((spec & 0xfff) | 7) + 1);
    const rows = ((spec >>> 12) & 0xff) + 1, skip = spec >>> 20;
    const isImem = (this.c0[0]! & 0x1000) !== 0;
    const mem = isImem ? this.imem : this.dmem;
    let m = this.c0[0]! & 0xff8, d = this.c0[1]! & 0xfffff8;
    for (let row = 0; row < rows; row++) {
      for (let i = 0; i < length; i++) {
        if (read) mem[(m + i) & DMEM_MASK] = this.ram[d + i]!;
        else this.ram[d + i] = mem[(m + i) & DMEM_MASK]!;
      }
      m = (m + length) & 0xfff;
      d += length + skip;
    }
  }

  private step(w: number, pc: number): void {
    const op = w >>> 26, rs = (w >>> 21) & 31, rt = (w >>> 16) & 31, rd = (w >>> 11) & 31, sa = (w >>> 6) & 31, fn = w & 63;
    const imm = w & 0xffff;
    const target = (pc + 4 + (s16(imm) << 2)) & 0xfff;
    const A = this.reg(rs), B = this.reg(rt);
    const branch = (cond: boolean) => { if (cond) this.branchTarget = target; };
    switch (op) {
      case 0:
        switch (fn) {
          case 0: this.setReg(rd, B << sa); break;
          case 2: this.setReg(rd, B >>> sa); break;
          case 3: this.setReg(rd, (B | 0) >> sa); break;
          case 4: this.setReg(rd, B << (A & 31)); break;
          case 6: this.setReg(rd, B >>> (A & 31)); break;
          case 7: this.setReg(rd, (B | 0) >> (A & 31)); break;
          case 8: this.branchTarget = A & 0xfff; break;
          case 9: this.setReg(rd, (pc + 8) & 0xfff); this.branchTarget = A & 0xfff; break;
          case 13: this.halted = true; this.status |= 3; break;
          case 0x20: case 0x21: this.setReg(rd, A + B); break;
          case 0x22: case 0x23: this.setReg(rd, A - B); break;
          case 0x24: this.setReg(rd, A & B); break;
          case 0x25: this.setReg(rd, A | B); break;
          case 0x26: this.setReg(rd, A ^ B); break;
          case 0x27: this.setReg(rd, ~(A | B)); break;
          case 0x2a: this.setReg(rd, (A | 0) < (B | 0) ? 1 : 0); break;
          case 0x2b: this.setReg(rd, A < B ? 1 : 0); break;
          default: throw new Error(`special ${fn.toString(16)} at ${pc.toString(16)}`);
        }
        break;
      case 1:
        if (rt === 0) branch((A | 0) < 0);
        else if (rt === 1) branch((A | 0) >= 0);
        else if (rt === 17) { this.setReg(31, (pc + 8) & 0xfff); branch((A | 0) >= 0); }
        else if (rt === 16) { this.setReg(31, (pc + 8) & 0xfff); branch((A | 0) < 0); }
        else throw new Error(`regimm ${rt} at ${pc.toString(16)}`);
        break;
      case 2: this.branchTarget = (w & 0x3ff) << 2; break;
      case 3: this.setReg(31, (pc + 8) & 0xfff); this.branchTarget = (w & 0x3ff) << 2; break;
      case 4: branch(A === B); break;
      case 5: branch(A !== B); break;
      case 6: branch((A | 0) <= 0); break;
      case 7: branch((A | 0) > 0); break;
      case 8: case 9: this.setReg(rt, A + s16(imm)); break;
      case 10: this.setReg(rt, (A | 0) < s16(imm) ? 1 : 0); break;
      case 11: this.setReg(rt, A < (s16(imm) >>> 0) ? 1 : 0); break;
      case 12: this.setReg(rt, A & imm); break;
      case 13: this.setReg(rt, A | imm); break;
      case 14: this.setReg(rt, A ^ imm); break;
      case 15: this.setReg(rt, imm << 16); break;
      case 16: this.cop0(rs, rt, rd); break;
      case 18: this.cop2(w, rs, rt, rd, sa, fn); break;
      case 32: this.setReg(rt, (this.rb(A + s16(imm)) << 24) >> 24); break;
      case 33: this.setReg(rt, s16(this.rh(A + s16(imm)))); break;
      case 35: case 39: this.setReg(rt, this.rw(A + s16(imm))); break;
      case 36: this.setReg(rt, this.rb(A + s16(imm))); break;
      case 37: this.setReg(rt, this.rh(A + s16(imm))); break;
      case 40: this.wb(A + s16(imm), B); break;
      case 41: this.wh(A + s16(imm), B); break;
      case 43: this.ww(A + s16(imm), B); break;
      case 50: case 58: {
        const sub = (w >>> 11) & 31;
        const ea = A + (((w & 0x7f) << 25) >> 25) * LOAD_STORE_SCALE[sub]!;
        if (op === 50) this.vload(sub, rt, (w >>> 7) & 15, ea);
        else this.vstore(sub, rt, (w >>> 7) & 15, ea);
        break;
      }
      default: throw new Error(`opcode ${op} at ${pc.toString(16)}`);
    }
  }

  private cop0(rs: number, rt: number, rd: number): void {
    if (rs === 0) {
      let value: number;
      switch (rd) {
        case 4: value = this.status; break;
        case 5: case 6: value = 0; break;
        case 7: value = this.semaphore; this.semaphore = 1; break;
        case 11: value = this.dpStatus; break;
        case 12: case 13: case 14: case 15: value = 0; break;
        default: value = this.c0[rd]!;
      }
      this.setReg(rt, value);
      return;
    }
    const value = this.reg(rt);
    switch (rd) {
      case 2: this.c0[2] = value; this.dma(true); break;
      case 3: this.c0[3] = value; this.dma(false); break;
      case 4:
        if (value & 1) this.halted = false;
        if (value & 2) this.halted = true;
        if (value & 4) this.status &= ~2;
        // Signal bits 7..14 are set and cleared in pairs; the other bits of the status are not modelled.
        for (let k = 0; k < 8; k++) {
          if (value & (1 << (9 + 2 * k))) this.status &= ~(1 << (7 + k));
          if (value & (1 << (10 + 2 * k))) this.status |= 1 << (7 + k);
        }
        break;
      case 7: this.semaphore = 0; break;
      case 8: this.c0[8] = value; this.c0[10] = value; break;
      case 9: this.dpEnd(value); break;
      case 11:
        if (value & 1) this.dpStatus &= ~1;
        if (value & 2) this.dpStatus |= 1;
        break;
      default: this.c0[rd] = value;
    }
  }

  /** The display processor's end register: the commands between start and end go to the RDP. */
  private dpEnd(end: number): void {
    const start = this.c0[10]!;
    const xbus = (this.dpStatus & 1) !== 0;
    const mask = xbus ? DMEM_MASK : 0xffffff;
    const s = start & mask, e = end & mask;
    if (e > s) this.rdp.push({ xbus, bytes: (xbus ? this.dmem : this.ram).slice(s, e) });
    this.c0[9] = end;
    this.c0[10] = end;
  }

  private vload(sub: number, vt: number, e: number, addr: number): void {
    const reg = this.v[vt]!;
    const bytes = [1, 2, 4, 8][sub];
    if (bytes !== undefined) {
      for (let i = 0; i < bytes; i++) reg[(e + i) & 15] = this.rb(addr + i);
    } else if (sub === 4) {
      const n = 16 - (addr & 15);
      for (let i = 0; i < n && e + i < 16; i++) reg[e + i] = this.rb(addr + i);
    } else if (sub === 5) {
      const n = addr & 15, base = addr & ~15;
      for (let i = 0; i < n; i++) reg[(e + 16 - n + i) & 15] = this.rb(base + i);
    } else if (sub === 6 || sub === 7) {
      // Eight bytes, each into a lane: shifted left by 8 (signed packed) or 7 (unsigned packed).
      const base = addr & ~7;
      for (let i = 0; i < 8; i++) {
        const b = this.rb(base + ((16 - e + i + (addr & 7)) & 15));
        const x = sub === 6 ? b << 8 : b << 7;
        reg[i * 2] = x >> 8;
        reg[i * 2 + 1] = x & 0xff;
      }
    } else if (sub === 8 || sub === 9) {
      // Half and fourth packed loads: bytes two (or four) apart, each shifted left by 7.
      const step = sub === 8 ? 2 : 4;
      const base = addr & ~7;
      for (let i = 0; i < 8; i++) {
        const b = this.rb(base + ((16 - e + i * step + (addr & 7)) & 15));
        const x = b << 7;
        reg[i * 2] = x >> 8;
        reg[i * 2 + 1] = x & 0xff;
      }
    } else {
      throw new Error(`vector load ${sub}`);
    }
  }

  private vstore(sub: number, vt: number, e: number, addr: number): void {
    const reg = this.v[vt]!;
    const bytes = [1, 2, 4, 8][sub];
    if (bytes !== undefined) {
      for (let i = 0; i < bytes; i++) this.wb(addr + i, reg[(e + i) & 15]!);
    } else if (sub === 4) {
      const n = 16 - (addr & 15);
      for (let i = 0; i < n; i++) this.wb(addr + i, reg[(e + i) & 15]!);
    } else if (sub === 5) {
      const n = addr & 15, base = addr & ~15;
      for (let i = 0; i < n; i++) this.wb(base + i, reg[(e + 16 - n + i) & 15]!);
    } else if (sub === 6 || sub === 7) {
      // Eight bytes from the lanes starting at lane e: packed signed (high byte of a lane) or unsigned (lane >> 7).
      for (let i = 0; i < 8; i++) {
        const idx = (e + i) & 15;
        const x = this.lane(vt, idx & 7) & 0xffff;
        const hi = (x >> 8) & 0xff, mid = (x >> 7) & 0xff;
        const first = sub === 6;
        this.wb(addr + i, idx < 8 === first ? hi : mid);
      }
    } else {
      throw new Error(`vector store ${sub}`);
    }
  }

  private cop2(w: number, rs: number, rt: number, rd: number, sa: number, fn: number): void {
    if (w & (1 << 25)) { this.vector(fn, sa, rd, rt, rs & 15); return; }
    const el = (w >>> 7) & 15;
    if (rs === 4) {
      const x = this.reg(rt);
      this.v[rd]![el] = (x >> 8) & 0xff;
      if (el < 15) this.v[rd]![el + 1] = x & 0xff;
    } else if (rs === 0) {
      this.setReg(rt, s16((this.v[rd]![el]! << 8) | this.v[rd]![(el + 1) & 15]!));
    } else if (rs === 2) {
      this.setReg(rt, s16(rd === 0 ? this.vco : rd === 1 ? this.vcc : this.vce));
    } else if (rs === 6) {
      const x = this.reg(rt) & 0xffff;
      if (rd === 0) this.vco = x;
      else if (rd === 1) this.vcc = x;
      else this.vce = x & 0xff;
    } else {
      throw new Error(`cop2 move ${rs}`);
    }
  }

  /** Splits a signed 48-bit accumulator lane into its 16-bit high, middle and low parts. */
  private static slices(acc: number): { hi: number; mid: number; lo: number } {
    return { hi: s16(Math.floor(acc / 4294967296)), mid: s16(Math.floor(acc / 65536)), lo: ((acc % 65536) + 65536) % 65536 };
  }

  private static wrap48(x: number): number {
    const m = 2 ** 48;
    return x >= -(m / 2) && x < m / 2 ? x : ((((x + m / 2) % m) + m) % m) - m / 2;
  }

  private static sat(acc: number, middle: boolean, negative: number, positive: number): number {
    const { hi, mid, lo } = GfxMicrocodeRef.slices(acc);
    if (hi < 0) {
      if (hi !== -1 || mid >= 0) return negative;
    } else if (hi !== 0 || mid < 0) {
      return positive;
    }
    return middle ? mid : lo;
  }

  private setAccLow(i: number, x: number) {
    this.acc[i] = this.acc[i]! - GfxMicrocodeRef.slices(this.acc[i]!).lo + (x & 0xffff);
  }

  private vector(fn: number, vd: number, vs: number, vt: number, e: number): void {
    const bc = BROADCAST[e]!;
    const a = (i: number) => this.lane(vs, i);
    const b = (i: number) => this.lane(vt, bc[i]!);
    const acc = this.acc;
    const mul = (accumulate: boolean, product: (i: number) => number, middle: boolean, negative: number, positive: number) => {
      const res: number[] = [];
      for (let i = 0; i < 8; i++) {
        acc[i] = GfxMicrocodeRef.wrap48((accumulate ? acc[i]! : 0) + product(i));
        res.push(GfxMicrocodeRef.sat(acc[i]!, middle, negative, positive));
      }
      res.forEach((x, i) => this.setLane(vd, i, x));
    };
    const store = (res: number[]) => res.forEach((x, i) => this.setLane(vd, i, x));
    switch (fn) {
      case 0x00: case 0x08: mul(fn === 8, (i) => a(i) * b(i) * 2 + (fn === 0 ? 0x8000 : 0), true, 0x8000, 0x7fff); break;
      case 0x01: case 0x09: {
        // Unsigned clamp of the accumulator: negative gives 0, and anything above the middle 16 bits gives 0xFFFF.
        const res: number[] = [];
        for (let i = 0; i < 8; i++) {
          acc[i] = GfxMicrocodeRef.wrap48((fn === 9 ? acc[i]! : 0) + a(i) * b(i) * 2 + (fn === 1 ? 0x8000 : 0));
          const { hi, mid } = GfxMicrocodeRef.slices(acc[i]!);
          res.push(hi < 0 ? 0 : hi !== 0 || mid < 0 ? -1 : mid);
        }
        store(res);
        break;
      }
      case 0x04: case 0x0c: mul(fn === 0xc, (i) => Math.floor((u16(a(i)) * u16(b(i))) / 65536), false, 0, 0xffff); break;
      case 0x05: case 0x0d: mul(fn === 0xd, (i) => a(i) * u16(b(i)), true, 0x8000, 0x7fff); break;
      case 0x06: case 0x0e: mul(fn === 0xe, (i) => u16(a(i)) * b(i), false, 0, 0xffff); break;
      case 0x07: case 0x0f: mul(fn === 0xf, (i) => a(i) * b(i) * 65536, true, 0x8000, 0x7fff); break;
      case 0x10: case 0x11: {
        const res: number[] = [];
        for (let i = 0; i < 8; i++) {
          const carry = (this.vco >> i) & 1;
          const sum = fn === 0x10 ? a(i) + b(i) + carry : a(i) - b(i) - carry;
          this.setAccLow(i, sum);
          res.push(Math.max(-32768, Math.min(32767, sum)));
        }
        store(res);
        this.vco = 0;
        break;
      }
      case 0x13: {
        const res: number[] = [];
        for (let i = 0; i < 8; i++) {
          const x = a(i), y = b(i);
          const r = x < 0 ? -y : x === 0 ? 0 : y;
          this.setAccLow(i, r);
          res.push(Math.max(-32768, Math.min(32767, r)));
        }
        store(res);
        break;
      }
      case 0x14: case 0x15: {
        let carry = 0, ne = 0;
        const res: number[] = [];
        for (let i = 0; i < 8; i++) {
          const sum = fn === 0x14 ? u16(a(i)) + u16(b(i)) : u16(a(i)) - u16(b(i));
          if (fn === 0x14 ? sum > 0xffff : sum < 0) carry |= 1 << i;
          if (fn === 0x15 && sum !== 0) ne |= 1 << i;
          this.setAccLow(i, sum);
          res.push(s16(sum));
        }
        store(res);
        this.vco = carry | (ne << 8);
        break;
      }
      case 0x1d:
        for (let i = 0; i < 8; i++) {
          const { hi, mid, lo } = GfxMicrocodeRef.slices(acc[i]!);
          this.setLane(vd, i, e === 8 ? hi : e === 9 ? mid : s16(lo));
        }
        break;
      case 0x20: case 0x21: case 0x22: case 0x23: {
        let cc = 0;
        const res: number[] = [];
        for (let i = 0; i < 8; i++) {
          const x = a(i), y = b(i);
          const carry = (this.vco >> i) & 1, ne = (this.vco >> (i + 8)) & 1;
          let pick: boolean;
          if (fn === 0x20) pick = x < y || (x === y && carry === 1 && ne === 1);
          else if (fn === 0x21) pick = x === y && ne === 0;
          else if (fn === 0x22) pick = x !== y || ne === 1;
          else pick = x > y || (x === y && !(carry === 1 && ne === 1));
          if (pick) cc |= 1 << i;
          const r = pick ? x : y;
          this.setAccLow(i, r);
          res.push(r);
        }
        store(res);
        this.vcc = cc;
        this.vco = 0;
        break;
      }
      case 0x24: this.vcl(vd, a, b); break;
      case 0x25: this.vch(vd, a, b); break;
      case 0x26: this.vcr(vd, a, b); break;
      case 0x27: {
        const res: number[] = [];
        for (let i = 0; i < 8; i++) {
          const r = (this.vcc >> i) & 1 ? a(i) : b(i);
          this.setAccLow(i, r);
          res.push(r);
        }
        store(res);
        this.vco = 0;
        break;
      }
      case 0x28: case 0x29: case 0x2a: case 0x2b: case 0x2c: case 0x2d:
        for (let i = 0; i < 8; i++) {
          const x = u16(a(i)), y = u16(b(i));
          const r = fn === 0x28 ? x & y : fn === 0x29 ? ~(x & y) : fn === 0x2a ? x | y : fn === 0x2b ? ~(x | y) : fn === 0x2c ? x ^ y : ~(x ^ y);
          this.setAccLow(i, r);
          this.setLane(vd, i, s16(r));
        }
        break;
      case 0x30: case 0x31: case 0x32: case 0x33: case 0x34: case 0x35: case 0x36: case 0x37:
        this.single(fn, vd, vs, vt, e);
        break;
      default: throw new Error(`vector op 0x${fn.toString(16)}`);
    }
  }

  private vch(vd: number, a: (i: number) => number, b: (i: number) => number): void {
    let co = 0, ne = 0, cc = 0, ce = 0;
    const res: number[] = [];
    for (let i = 0; i < 8; i++) {
      const x = a(i), y = b(i);
      let le: boolean, ge: boolean, clip: number;
      if ((x ^ y) < 0) {
        const sum = x + y;
        co |= 1 << i;
        if (sum === -1) ce |= 1 << i;
        if (sum !== -1 && sum !== 0) ne |= 1 << i;
        le = sum <= 0;
        ge = y < 0;
        clip = le ? -y : x;
      } else {
        le = y < 0;
        ge = x - y >= 0;
        if (x !== y) ne |= 1 << i;
        clip = ge ? y : x;
      }
      if (le) cc |= 1 << i;
      if (ge) cc |= 1 << (i + 8);
      this.setAccLow(i, clip);
      res.push(s16(clip));
    }
    res.forEach((x, i) => this.setLane(vd, i, x));
    this.vco = co | (ne << 8);
    this.vcc = cc;
    this.vce = ce;
  }

  private vcl(vd: number, a: (i: number) => number, b: (i: number) => number): void {
    const res: number[] = [];
    let cc = this.vcc;
    for (let i = 0; i < 8; i++) {
      const x = a(i), y = b(i);
      const carry = (this.vco >> i) & 1, ne = (this.vco >> (i + 8)) & 1, ce = (this.vce >> i) & 1;
      let clip: number;
      if (carry) {
        if (!ne) {
          const sum = u16(x) + u16(y);
          const le = ce ? sum <= 0x10000 : sum === 0;
          cc = (cc & ~(1 << i)) | ((le ? 1 : 0) << i);
        }
        clip = (cc >> i) & 1 ? -y : x;
      } else {
        if (!ne) {
          const ge = u16(x) >= u16(y);
          cc = (cc & ~(1 << (i + 8))) | ((ge ? 1 : 0) << (i + 8));
        }
        clip = (cc >> (i + 8)) & 1 ? y : x;
      }
      this.setAccLow(i, clip);
      res.push(s16(clip));
    }
    res.forEach((x, i) => this.setLane(vd, i, x));
    this.vcc = cc;
    this.vco = 0;
    this.vce = 0;
  }

  private vcr(vd: number, a: (i: number) => number, b: (i: number) => number): void {
    let cc = 0;
    const res: number[] = [];
    for (let i = 0; i < 8; i++) {
      const x = a(i), y = b(i);
      let le: boolean, ge: boolean, clip: number;
      if ((x ^ y) < 0) {
        ge = y < 0;
        le = x + y + 1 <= 0;
        clip = le ? ~y : x;
      } else {
        le = y < 0;
        ge = x - y >= 0;
        clip = ge ? y : x;
      }
      if (le) cc |= 1 << i;
      if (ge) cc |= 1 << (i + 8);
      this.setAccLow(i, clip);
      res.push(s16(clip));
    }
    res.forEach((x, i) => this.setLane(vd, i, x));
    this.vcc = cc;
    this.vco = 0;
    this.vce = 0;
  }

  /** The divide unit and the lane move: one input lane of `vt`, one output lane of `vd`. */
  private single(fn: number, vd: number, vs: number, vt: number, e: number): void {
    const bc = BROADCAST[e]!;
    const de = vs & 7;
    const inputLane = bc[de]!;
    for (let i = 0; i < 8; i++) this.setAccLow(i, this.lane(vt, bc[i]!));
    if (fn === 0x33) {
      this.setLane(vd, de, this.lane(vt, inputLane));
      return;
    }
    if (fn === 0x37) return;
    const high = fn === 0x32 || fn === 0x36;
    if (high) {
      this.setLane(vd, de, s16(this.divOut));
      this.divIn = this.lane(vt, inputLane);
      this.divDp = true;
      return;
    }
    const low = fn === 0x31 || fn === 0x35;
    const rsq = fn === 0x34 || fn === 0x35;
    let input: number;
    if (low && this.divDp) input = ((this.divIn << 16) | u16(this.lane(vt, inputLane))) | 0;
    else input = this.lane(vt, inputLane);
    const mask = input >> 31;
    let data = input ^ mask;
    if (input > -32768) data -= mask;
    let result: number;
    if (data === 0) result = 0x7fffffff;
    else if (input === -32768 && !(low && this.divDp)) result = 0xffff0000 | 0;
    else {
      const shift = Math.clz32(data);
      const index = ((data << shift) & 0x7fc00000) >>> 22;
      if (rsq) {
        const value = INVERSE_SQUARE_ROOTS[(index & 0x1fe) | (shift & 1)]!;
        result = ((0x10000 | value) << 14) >>> ((31 - shift) >> 1);
      } else {
        result = ((0x10000 | RECIPROCALS[index]!) << 14) >>> (31 - shift);
      }
      result = (result ^ mask) | 0;
    }
    this.divDp = false;
    this.divOut = result >> 16;
    this.setLane(vd, de, s16(result));
  }
}
