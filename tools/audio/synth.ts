// The audio command-list interpreter (docs/re/audio.md): runs the 8-byte commands the game builds each frame against a
// 4 KiB working memory, reading and writing the guest's memory where the commands name a RAM address. All sample data is
// 16-bit big-endian, as in the guest.

const DMEM_SIZE = 0x1000;
/** Where the ADPCM prediction codebook is loaded in the working memory (the data segment's 0x330). */
const BOOK = 0x330;
/** The resampler's four-tap filter table, 64 entries of four s16 each, in the working memory. */
const FILTER_TABLE_SIZE = 64 * 4;
/** Scratch the resampler and the filter keep their state in. */
const STATE_SCRATCH = 0xfb0;

const s16 = (n: number) => (n << 16) >> 16;
const clamp16 = (n: number) => (n > 32767 ? 32767 : n < -32768 ? -32768 : n);

/** The rounded product of two s16 values, scaled by 1/32768, that the microcode's `vmulf` computes. */
const mulf = (a: number, b: number) => Math.floor((a * b * 2 + 0x8000) / 65536);

/** Where the resampler's filter table lies in the microcode's data segment. */
const FILTER_TABLE_OFFSET = 0xe0;

/** One audio task: the command list and the microcode data segment it comes with, as physical addresses. */
export interface AudioTaskRef {
  list: number;
  size: number;
  dataSegment: number;
}

export class Synth {
  readonly dmem = new Uint8Array(DMEM_SIZE);
  private dv = new DataView(this.dmem.buffer);
  private ram: Uint8Array = new Uint8Array(0);
  private ramView: DataView = new DataView(this.ram.buffer);
  private filterTable = new Int16Array(FILTER_TABLE_SIZE);
  private filterTableAt = -1;
  private inAddr = 0;
  private outAddr = 0;
  private count = 0;
  private loopAddr = 0;
  // Envelope mixer parameters, set by two commands and consumed by the next envelope mix.
  private rateL = 0;
  private rateR = 0;
  private rateWet = 0;
  private volL = 0;
  private volR = 0;
  private volWet = 0;
  private filterCount = 0;

  private ld(a: number) { return this.dv.getInt16(a & 0xffe); }
  private st(a: number, v: number) { this.dv.setInt16(a & 0xffe, v); }
  private ldu(a: number) { return this.dv.getUint16(a & 0xffe); }

  /** Copies `bytes` (rounded up to 8) from guest memory into the working memory. */
  private dmaIn(dmem: number, ramAddr: number, bytes: number): void {
    const n = Math.ceil(bytes / 8) * 8;
    const from = ramAddr & 0x7ffff8, to = dmem & 0xff8;
    for (let i = 0; i < n; i++) this.dmem[(to + i) & 0xfff] = this.ram[from + i]!;
  }

  private dmaOut(dmem: number, ramAddr: number, bytes: number): void {
    const n = Math.ceil(bytes / 8) * 8;
    const to = ramAddr & 0x7ffff8, from = dmem & 0xff8;
    for (let i = 0; i < n; i++) this.ram[to + i] = this.dmem[(from + i) & 0xfff]!;
  }

  /** Runs the commands of `task` in `ram`, the guest memory indexed by physical address. */
  run(ram: Uint8Array, task: AudioTaskRef): void {
    this.ram = ram;
    this.ramView = new DataView(ram.buffer, ram.byteOffset, ram.byteLength);
    this.loadFilterTable(task.dataSegment & 0x7ffffc);
    for (let at = task.list & 0x7ffff8, end = at + task.size; at + 8 <= end; at += 8) {
      this.command(this.ramView.getUint32(at), this.ramView.getUint32(at + 4));
    }
  }

  private loadFilterTable(dataSegment: number): void {
    if (this.filterTableAt === dataSegment) return;
    for (let i = 0; i < FILTER_TABLE_SIZE; i++) this.filterTable[i] = this.ramView.getInt16(dataSegment + FILTER_TABLE_OFFSET + i * 2);
    this.filterTableAt = dataSegment;
  }

  private command(w0: number, w1: number): void {
    switch (w0 >>> 24) {
      case 0x01: this.adpcm(w0, w1); break;
      case 0x02: this.clear(w0 & 0xffff, w1 & 0xffff); break;
      case 0x05: this.resample(w0, w1); break;
      case 0x07: this.filter(w0, w1); break;
      case 0x08: this.inAddr = w0 & 0xffff; this.outAddr = w1 >>> 16; this.count = w1 & 0xffff; break;
      case 0x09: this.repeat128(w0, w1); break;
      case 0x0a: this.move(w0 & 0xffff, w1 >>> 16, w1 & 0xffff); break;
      case 0x0b: this.dmaIn(BOOK, w1 & 0xffffff, w0 & 0xffff); break;
      case 0x0c: this.mix(w0, w1); break;
      case 0x0d: this.interleave(w0, w1); break;
      case 0x0e: this.gainBuffer(w0, w1); break;
      case 0x0f: this.loopAddr = w1 & 0xffffff; break;
      case 0x10: this.copy(w0, w1); break;
      case 0x11: this.decimate(w0 & 0xffff, w1 >>> 16, w1 & 0xffff); break;
      case 0x12:
        this.volWet = (w0 >>> 8) & 0xff00;
        this.rateWet = w0 & 0xffff;
        this.rateL = w1 >>> 16;
        this.rateR = w1 & 0xffff;
        this.volL = 0;
        this.volR = 0;
        break;
      case 0x13: this.envelopeMix(w0, w1); break;
      case 0x14: this.dmaIn(w0 & 0xffff, w1 & 0xffffff, (w0 >>> 12) & 0xff0); break;
      case 0x15: this.dmaOut(w0 & 0xffff, w1 & 0xffffff, (w0 >>> 12) & 0xff0); break;
      case 0x16: this.volL = w1 >>> 16; this.volR = w1 & 0xffff; break;
      default: throw new Error(`unknown audio command 0x${(w0 >>> 24).toString(16)}`);
    }
  }

  // The microcode clears and copies eight bytes at a time and does not need the addresses aligned.
  private clear(addr: number, count: number): void {
    for (let n = count; n > 0; n -= 16, addr += 16) for (let i = 0; i < 16; i++) this.dmem[(addr + i) & 0xfff] = 0;
  }

  private move(from: number, to: number, count: number): void {
    const chunk = new Uint8Array(16);
    for (let n = count; n > 0; n -= 16, from += 16, to += 16) {
      for (let i = 0; i < 16; i++) chunk[i] = this.dmem[(from + i) & 0xfff]!;
      for (let i = 0; i < 16; i++) this.dmem[(to + i) & 0xfff] = chunk[i]!;
    }
  }

  private requireAligned(...addresses: number[]): void {
    if (addresses.some((a) => a & 15)) throw new Error('audio copy command with an address that is not a multiple of 16');
  }

  /** Writes the 128 bytes at the source to the destination, then to the 128 bytes after it, `w0` bits 16-23 times in all. */
  private repeat128(w0: number, w1: number): void {
    const src = w0 & 0xffff, dst = w1 >>> 16;
    this.requireAligned(src, dst);
    const block = this.dmem.slice(src, src + 128);
    for (let n = Math.max(1, (w0 >>> 16) & 0xff), at = dst; n > 0; n--, at += 128) this.dmem.set(block, at);
  }

  /** Copies `w1` low 16 bytes, in 32-byte steps, from the source to the destination, `w0` bits 16-23 times over in a row. */
  private copy(w0: number, w1: number): void {
    let src = w0 & 0xffff, dst = w1 >>> 16;
    this.requireAligned(src, dst);
    for (let n = Math.max(1, (w0 >>> 16) & 0xff); n > 0; n--) {
      let left = w1 & 0xffff;
      do {
        const chunk = this.dmem.slice(src, src + 32);
        this.dmem.set(chunk, dst);
        src += 32;
        dst += 32;
        left -= 32;
      } while (left > 0);
    }
  }

  /** out[i] = in[i] * gain + out[i] over `count` bytes of 16-bit samples. */
  private mix(w0: number, w1: number): void {
    const gain = s16(w0 & 0xffff);
    const count = (w0 >>> 12) & 0xff0;
    const dst = w1 & 0xffff, src = w1 >>> 16;
    for (let off = 0; off < Math.ceil(count / 32) * 32; off += 2) {
      const acc = this.ld(dst + off) * 0x7fff * 2 + 0x8000 + this.ld(src + off) * gain * 2;
      this.st(dst + off, clamp16(Math.floor(acc / 65536)));
    }
  }

  /**
   * Multiplies `w0` low 16 bytes of samples at `w1` high 16, in place and in 32-byte steps (at least one), by the gain in
   * `w0` bits 16-23: four integer and four fraction bits. Results saturate to 16 bits.
   */
  private gainBuffer(w0: number, w1: number): void {
    const whole = (w0 >>> 20) & 0xf, fraction = (w0 >>> 16) & 0xf;
    const addr = w1 >>> 16;
    this.requireAligned(addr);
    for (let off = 0; off < Math.max(32, Math.ceil((w0 & 0xffff) / 32) * 32); off += 2) {
      const x = this.ld(addr + off);
      this.st(addr + off, clamp16(x * whole + Math.floor((x * (fraction << 12)) / 65536)));
    }
  }

  /** Writes the two channels `left` and `right` (count bytes each) alternately into `out`. */
  private interleave(w0: number, w1: number): void {
    const out = w0 & 0xffff;
    const count = (w0 >>> 12) & 0xff0;
    const left = w1 >>> 16, right = w1 & 0xffff;
    for (let i = 0, o = out; i < Math.ceil(count / 8) * 8; i += 2, o += 4) {
      this.st(o, this.ld(left + i));
      this.st(o + 2, this.ld(right + i));
    }
  }

  private decimate(count: number, src: number, dst: number): void {
    const groups = Math.max(1, Math.ceil(count / 8));
    for (let g = 0; g < groups; g++) {
      for (let k = 0; k < 8; k++) this.st(dst + g * 16 + k * 2, this.ld(src + g * 32 + k * 4));
    }
  }

  private envelopeMix(w0: number, w1: number): void {
    const flags = w0 & 0xff;
    const samples = (w0 >>> 8) & 0xff;
    const input = (w0 >>> 12) & 0xff0;
    const dryL = (w1 >>> 20) & 0xff0, dryR = (w1 >>> 12) & 0xff0, wetL = (w1 >>> 4) & 0xff0, wetR = (w1 << 4) & 0xff0;
    // Each flag selects an exclusive-or mask applied to one of the four signals of a half (dry left, dry right, then wet).
    const maskL = (flags & 2) ? 0xffff : 0;
    const maskR = (flags & 1) ? 0xffff : 0;
    const maskWetL = (flags & 8) ? 0xfffc : 0;
    const maskWetR = (flags & 4) ? 0xfffe : 0;
    const swap = (flags & 0x10) !== 0;
    // Volumes are unsigned 16-bit fractions that change by the rate once per eight samples.
    const volumeAt = (volume: number, rate: number, eight: number) => (volume + rate * eight) & 0xffff;
    const scale = (x: number, volume: number) => Math.floor((x * volume) / 65536);
    const add = (a: number, b: number) => clamp16(a + b);
    for (let batch = 0, left = Math.max(1, Math.ceil(samples / 16)); left > 0; batch++, left--) {
      for (let half = 0; half < 2; half++) {
        const eight = batch * 2 + half;
        const volL = volumeAt(this.volL, this.rateL, eight);
        const volR = volumeAt(this.volR, this.rateR, eight);
        const volWet = volumeAt(this.volWet, this.rateWet, eight);
        for (let k = 0; k < 8; k++) {
          const off = batch * 32 + half * 16 + k * 2;
          const x = this.ld(input + off);
          const l = s16(scale(x, volL) ^ maskL);
          const r = s16(scale(x, volR) ^ maskR);
          this.st(dryL + off, add(this.ld(dryL + off), l));
          this.st(dryR + off, add(this.ld(dryR + off), r));
          const wl = s16(scale(l, volWet) ^ maskWetL);
          const wr = s16(scale(r, volWet) ^ maskWetR);
          this.st(wetL + off, add(this.ld(wetL + off), swap ? wr : wl));
          this.st(wetR + off, add(this.ld(wetR + off), swap ? wl : wr));
        }
      }
    }
  }

  private adpcm(w0: number, w1: number): void {
    const flags = (w0 >>> 16) & 0xff;
    const stateAddr = w1 & 0xffffff;
    // Samples are 4 bits wide, or 2 in the second form; a frame is a header byte and 16 of them.
    const bits = flags & 4 ? 2 : 4;
    const frameBytes = 1 + (16 * bits) / 8;
    const out = this.outAddr;
    this.dmem.fill(0, out & 0xff8, (out & 0xff8) + 32);
    if (!(flags & 1)) this.dmaIn(out, flags & 2 ? this.loopAddr : stateAddr, 32);
    let o = out + 32;
    let src = this.inAddr;
    const ins = new Array<number>(16).fill(0);
    for (let remaining = this.count; remaining > 0; remaining -= 32) {
      const header = this.dmem[src & 0xfff]!;
      const book = BOOK + (header & 0xf) * 32;
      const scale = header >> 4;
      // A sample is the signed value of its bits, shifted left by the scale.
      for (let i = 0; i < 16; i++) {
        const perByte = 8 / bits;
        const byte = this.dmem[(src + 1 + Math.floor(i / perByte)) & 0xfff]!;
        const raw = (byte >> (8 - bits * ((i % perByte) + 1))) & ((1 << bits) - 1);
        ins[i] = s16(raw << (16 - bits)) >> (16 - bits - scale);
      }
      for (let half = 0; half < 2; half++) {
        const p2 = this.ld(o - 4), p1 = this.ld(o - 2);
        for (let i = 0; i < 8; i++) {
          let acc = ins[half * 8 + i]! * 2048 + this.ld(book + i * 2) * p2 + this.ld(book + 16 + i * 2) * p1;
          for (let j = 0; j < i; j++) acc += ins[half * 8 + j]! * this.ld(book + 16 + (i - 1 - j) * 2);
          this.st(o + i * 2, clamp16(Math.floor(acc / 2048)));
        }
        o += 16;
      }
      src += frameBytes;
    }
    this.dmaOut(o - 32, stateAddr, 32);
  }

  private resample(w0: number, w1: number): void {
    const flags = (w0 >>> 16) & 0xff;
    const pitch = w0 & 0xffff;
    const stateAddr = w1 & 0xffffff;
    const state = STATE_SCRATCH;
    if (flags & 1) {
      this.st(state + 8, 0);
      this.dmem.fill(0, state, state + 8);
    } else {
      this.dmaIn(state, stateAddr, 32);
    }
    let base = this.inAddr;
    if (flags & 2) {
      base -= 4;
      this.dmem.copyWithin(base & 0xfff, state, state + 2);
      this.dmem.copyWithin((base + 2) & 0xfff, state + 4, state + 6);
    } else if (flags & 4) {
      base -= 16;
      for (let k = 0; k < 4; k++) {
        this.dmem.copyWithin((base + k * 4) & 0xfff, state + k * 2, state + k * 2 + 2);
        this.dmem.copyWithin((base + k * 4 + 2) & 0xfff, state + k * 2, state + k * 2 + 2);
      }
    } else {
      base -= 8;
      this.dmem.copyWithin(base & 0xfff, state, state + 8);
    }
    // Positions are 16.16 fixed point, in samples from `inAddr`; one output advances by pitch / 0x8000 samples.
    let pos = this.ldu(state + 8);
    const step = pitch * 2;
    const outputs = Math.max(1, Math.ceil(this.count / 16)) * 8;
    for (let n = 0; n < outputs; n++, pos += step) {
      const whole = Math.floor(pos / 65536);
      const at = base + whole * 2;
      const tap = ((pos % 65536) >> 10) * 4;
      const p = (k: number) => mulf(this.ld(at + k * 2), this.filterTable[tap + k]!);
      const y = clamp16(clamp16(p(0) + p(1)) + clamp16(p(2) + p(3)));
      this.st(this.outAddr + n * 2, y);
    }
    const whole = Math.floor(pos / 65536);
    this.st(state + 8, pos % 65536);
    this.dmem.copyWithin(state, (base + whole * 2) & 0xfff, ((base + whole * 2) & 0xfff) + 8);
    this.dmaOut(state, stateAddr, 32);
  }

  /**
   * An 8-tap filter over a buffer, in place. Flags 2 and up load the coefficients and the length for the run command that
   * follows; the others run it. The coefficients actually used are the mean of the loaded ones and those the previous run
   * left in its state, and that mean is what the state keeps, so a change of coefficients takes effect gradually.
   */
  private filter(w0: number, w1: number): void {
    const flags = (w0 >>> 16) & 0xff;
    const state = STATE_SCRATCH;
    this.dmem.fill(0, state, state + 32);
    if (flags >= 2) {
      this.filterCount = w0 & 0xffff;
      this.dmem.fill(0, state + 32, state + 48);
      this.dmem.fill(0, state + 64, state + 80);
      this.dmaIn(state + 48, w1 & 0xffffff, 16);
      return;
    }
    if (flags === 0) this.dmaIn(state, w1 & 0xffffff, 32);
    const coef: number[] = [];
    for (let i = 0; i < 8; i++) {
      const mean = clamp16(Math.floor((0x8000 + this.ld(state + 48 + i * 2) * 0x8000 + this.ld(state + 16 + i * 2) * 0x8000) / 65536));
      coef.push(mean);
      this.st(state + 48 + i * 2, mean);
      this.st(state + 16 + i * 2, mean);
    }
    const buffer = w0 & 0xffff;
    const history: number[] = [];
    for (let i = 0; i < 8; i++) history.push(this.ld(state + i * 2));
    for (let off = 0, left = this.filterCount; off === 0 || left > 0; off += 16, left -= 16) {
      const x: number[] = [];
      for (let i = 0; i < 8; i++) x.push(this.ld(buffer + off + i * 2));
      for (let i = 0; i < 8; i++) {
        let acc = 0x8000;
        for (let j = 0; j < 8; j++) {
          const k = i - j;
          acc += 2 * coef[j]! * (k >= 0 ? x[k]! : history[8 + k]!);
        }
        this.st(buffer + off + i * 2, clamp16(Math.floor(acc / 65536)));
      }
      for (let i = 0; i < 8; i++) history[i] = x[i]!;
    }
    for (let i = 0; i < 8; i++) this.st(state + i * 2, history[i]!);
    this.dmaOut(state, w1 & 0xffffff, 32);
  }
}
