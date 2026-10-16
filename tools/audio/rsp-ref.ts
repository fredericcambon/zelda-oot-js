// Reference execution of the audio microcode, used only by tests to check the mixer in `synth.ts` against what the
// microcode computes on the same command list. It implements the RSP instructions the audio microcode contains (the
// scalar subset, the DMA registers and the vector unit as documented at n64brew.dev); nothing in the shipped game runs it.

import { LOAD_STORE_SCALE } from './rspdis.ts';

const DMEM_MASK = 0xfff;

/** The task record the microcode reads from the top of DMEM (0xfc0), as the boot microcode would leave it. */
export interface RefTask {
  /** Physical address of the microcode's data segment and its size minus one. */
  dataPtr: number;
  dataSize: number;
  /** Physical address and size in bytes of the command list. */
  listPtr: number;
  listSize: number;
}

const s16 = (n: number) => (n << 16) >> 16;
const u16 = (n: number) => n & 0xffff;

export class RspReference {
  readonly dmem = new Uint8Array(0x1000);
  private imem: Uint32Array;
  private r = new Uint32Array(32);
  private v = Array.from({ length: 32 }, () => new Uint8Array(16));
  private acc: number[] = new Array<number>(8).fill(0);
  private vco = 0;
  private c0 = new Uint32Array(16);
  private semaphore = 0;
  private ram: Uint8Array = new Uint8Array(0);
  private branchTarget: number | null = null;
  private halted = false;

  /** `code` is the 4 KiB of microcode text. */
  constructor(code: Uint8Array) {
    const dv = new DataView(code.buffer, code.byteOffset, code.byteLength);
    this.imem = new Uint32Array(1024);
    for (let i = 0; i < 1024; i++) this.imem[i] = dv.getUint32(i * 4);
  }

  private rb(a: number) { return this.dmem[a & DMEM_MASK]!; }
  private rh(a: number) { return (this.rb(a) << 8) | this.rb(a + 1); }
  private rw(a: number) { return ((this.rb(a) << 24) | (this.rb(a + 1) << 16) | (this.rb(a + 2) << 8) | this.rb(a + 3)) >>> 0; }
  private wb(a: number, x: number) { this.dmem[a & DMEM_MASK] = x & 0xff; }
  private wh(a: number, x: number) { this.wb(a, x >> 8); this.wb(a + 1, x); }
  private ww(a: number, x: number) { this.wh(a, x >>> 16); this.wh(a + 2, x & 0xffff); }

  private lane(reg: number, i: number) { const b = this.v[reg]!; return s16((b[i * 2]! << 8) | b[i * 2 + 1]!); }
  private setLane(reg: number, i: number, x: number) { const b = this.v[reg]!; b[i * 2] = (x >> 8) & 0xff; b[i * 2 + 1] = x & 0xff; }

  /**
   * Runs the microcode on `task` until it halts, with the DMA reading and writing `ram`, the guest memory indexed by
   * physical address. Registers and working memory keep their values from the previous run, as
   * they do on the console.
   */
  run(ram: Uint8Array, task: RefTask): void {
    this.ram = ram;
    this.halted = false;
    this.ww(0xfc0 + 0x18, task.dataPtr);
    this.ww(0xfc0 + 0x1c, task.dataSize);
    this.ww(0xfc0 + 0x30, task.listPtr);
    this.ww(0xfc0 + 0x34, task.listSize);
    let pc = 0;
    for (let steps = 0; steps < 50_000_000 && !this.halted; steps++) {
      this.step(this.imem[pc >> 2]!, pc);
      if (this.branchTarget !== null) {
        const target = this.branchTarget;
        this.branchTarget = null;
        this.step(this.imem[((pc + 4) & 0xfff) >> 2]!, (pc + 4) & 0xfff);
        pc = target;
      } else {
        pc = (pc + 4) & 0xfff;
      }
    }
    if (!this.halted) throw new Error('microcode did not halt');
  }

  private reg(n: number) { return n === 0 ? 0 : this.r[n]!; }
  private setReg(n: number, x: number) { if (n !== 0) this.r[n] = x >>> 0; }

  private dmaRead(): void {
    const len = ((this.c0[2]! & 0xfff) | 7) + 1;
    const mem = this.c0[0]! & 0xff8, dram = this.c0[1]! & 0xfffff8;
    for (let i = 0; i < len; i++) this.dmem[(mem + i) & DMEM_MASK] = this.ram[dram + i]!;
  }

  private dmaWrite(): void {
    const len = ((this.c0[3]! & 0xfff) | 7) + 1;
    const mem = this.c0[0]! & 0xff8, dram = this.c0[1]! & 0xfffff8;
    for (let i = 0; i < len; i++) this.ram[dram + i] = this.dmem[(mem + i) & DMEM_MASK]!;
  }

  private step(w: number, pc: number): void {
    const op = w >>> 26, rs = (w >>> 21) & 31, rt = (w >>> 16) & 31, rd = (w >>> 11) & 31, sa = (w >>> 6) & 31, fn = w & 63;
    const imm = w & 0xffff;
    const target = (pc + 4 + (s16(imm) << 2)) & 0xfff;
    const A = this.reg(rs), B = this.reg(rt);
    const branch = (cond: boolean) => { if (cond) this.branchTarget = target; };
    const vecAddr = () => A + (((w & 0x7f) << 25) >> 25) * LOAD_STORE_SCALE[(w >>> 11) & 31]!;
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
          case 13: this.halted = true; break;
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
      case 50: this.vload((w >>> 11) & 31, rt, (w >>> 7) & 15, vecAddr()); break;
      case 58: this.vstore((w >>> 11) & 31, rt, (w >>> 7) & 15, vecAddr()); break;
      default: throw new Error(`opcode ${op} at ${pc.toString(16)}`);
    }
  }

  private cop0(rs: number, rt: number, rd: number): void {
    if (rs === 0) {
      // Status registers read as idle: no DMA pending and the display processor not busy; the semaphore is taken on read.
      if (rd === 7) { this.setReg(rt, this.semaphore); this.semaphore = 1; return; }
      this.setReg(rt, rd === 5 || rd === 6 || rd === 11 ? 0 : this.c0[rd]!);
      return;
    }
    const value = this.reg(rt);
    if (rd === 7) { this.semaphore = 0; return; }
    this.c0[rd] = value;
    if (rd === 2) this.dmaRead();
    else if (rd === 3) this.dmaWrite();
    else if (rd === 4 && (value & 0x4002) !== 0) this.halted = true;
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
    } else if (sub === 6) {
      // Eight bytes, each into the high byte of a lane.
      const base = addr & ~7;
      for (let i = 0; i < 8; i++) { reg[i * 2] = this.rb(base + ((16 - e + i + (addr & 7)) & 15)); reg[i * 2 + 1] = 0; }
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
    } else {
      throw new Error(`cop2 move ${rs}`);
    }
  }

  private static readonly BROADCAST: number[][] = [
    [0, 1, 2, 3, 4, 5, 6, 7], [0, 1, 2, 3, 4, 5, 6, 7], [0, 0, 2, 2, 4, 4, 6, 6], [1, 1, 3, 3, 5, 5, 7, 7],
    [0, 0, 0, 0, 4, 4, 4, 4], [1, 1, 1, 1, 5, 5, 5, 5], [2, 2, 2, 2, 6, 6, 6, 6], [3, 3, 3, 3, 7, 7, 7, 7],
    ...Array.from({ length: 8 }, (_, k) => new Array<number>(8).fill(k)),
  ];

  /** The three 16-bit slices of an accumulator lane, which holds a signed 48-bit integer. */
  private static slices(acc: number): { hi: number; mid: number; lo: number } {
    return { hi: s16(Math.floor(acc / 4294967296)), mid: s16(Math.floor(acc / 65536)), lo: ((acc % 65536) + 65536) % 65536 };
  }

  /** Wraps to 48 bits as the accumulator does. */
  private static wrap(x: number): number {
    const m = 2 ** 48;
    return x >= -(m / 2) && x < m / 2 ? x : ((((x + m / 2) % m) + m) % m) - m / 2;
  }

  /** A lane of the accumulator as a 16-bit result, saturating when it does not fit. */
  private sat(acc: number, middle: boolean, negative: number, positive: number): number {
    const { hi, mid, lo } = RspReference.slices(acc);
    if (hi < 0) {
      if (hi !== -1 || mid >= 0) return negative;
    } else if (hi !== 0 || mid < 0) {
      return positive;
    }
    return middle ? mid : lo;
  }

  private vector(fn: number, vd: number, vs: number, vt: number, e: number): void {
    const bc = RspReference.BROADCAST[e]!;
    const a = (i: number) => this.lane(vs, i);
    const b = (i: number) => this.lane(vt, bc[i]!);
    const acc = this.acc;
    const U = u16;
    const setLow = (i: number, x: number) => { acc[i] = acc[i]! - RspReference.slices(acc[i]!).lo + (x & 0xffff); };
    const mul = (accumulate: boolean, product: (i: number) => number, middle: boolean, negative: number, positive: number) => {
      const res: number[] = [];
      for (let i = 0; i < 8; i++) {
        acc[i] = RspReference.wrap((accumulate ? acc[i]! : 0) + product(i));
        res.push(this.sat(acc[i]!, middle, negative, positive));
      }
      res.forEach((x, i) => this.setLane(vd, i, x));
    };
    switch (fn) {
      case 0x00: case 0x08: mul(fn === 8, (i) => a(i) * b(i) * 2 + (fn === 0 ? 0x8000 : 0), true, 0x8000, 0x7fff); break;
      case 0x04: case 0x0c: mul(fn === 0xc, (i) => Math.floor((U(a(i)) * U(b(i))) / 65536), false, 0, 0xffff); break;
      case 0x05: case 0x0d: mul(fn === 0xd, (i) => a(i) * U(b(i)), true, 0x8000, 0x7fff); break;
      case 0x06: case 0x0e: mul(fn === 0xe, (i) => U(a(i)) * b(i), false, 0, 0xffff); break;
      case 0x07: case 0x0f: mul(fn === 0xf, (i) => a(i) * b(i) * 65536, true, 0x8000, 0x7fff); break;
      case 0x10: case 0x11: {
        const res: number[] = [];
        for (let i = 0; i < 8; i++) {
          const carry = (this.vco >> i) & 1;
          const sum = fn === 0x10 ? a(i) + b(i) + carry : a(i) - b(i) - carry;
          setLow(i, sum);
          res.push(Math.max(-32768, Math.min(32767, sum)));
        }
        res.forEach((x, i) => this.setLane(vd, i, x));
        this.vco = 0;
        break;
      }
      case 0x14: case 0x15: {
        let carry = 0;
        const res: number[] = [];
        for (let i = 0; i < 8; i++) {
          const sum = fn === 0x14 ? u16(a(i)) + u16(b(i)) : u16(a(i)) - u16(b(i));
          if (fn === 0x14 ? sum > 0xffff : sum < 0) carry |= 1 << i;
          setLow(i, sum);
          res.push(s16(sum));
        }
        res.forEach((x, i) => this.setLane(vd, i, x));
        this.vco = carry;
        break;
      }
      case 0x1d:
        for (let i = 0; i < 8; i++) {
          const { hi, mid, lo } = RspReference.slices(acc[i]!);
          this.setLane(vd, i, e === 8 ? hi : e === 9 ? mid : s16(lo));
        }
        break;
      case 0x28: case 0x29: case 0x2a: case 0x2b: case 0x2c: case 0x2d:
        for (let i = 0; i < 8; i++) {
          const x = u16(a(i)), y = u16(b(i));
          const r = fn === 0x28 ? x & y : fn === 0x29 ? ~(x & y) : fn === 0x2a ? x | y : fn === 0x2b ? ~(x | y) : fn === 0x2c ? x ^ y : ~(x ^ y);
          setLow(i, r);
          this.setLane(vd, i, s16(r));
        }
        break;
      default: throw new Error(`vector op 0x${fn.toString(16)}`);
    }
  }
}
