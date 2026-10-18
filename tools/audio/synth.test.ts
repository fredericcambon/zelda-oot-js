import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { loadContext } from '../analyze/context.ts';
import { buildSpecs } from '../analyze/image.ts';
import { RspReference } from './rsp-ref.ts';
import { Synth } from './synth.ts';

const RAM_SIZE = 0x100000;
const LIST = 0x1000;
const DATA_SEGMENT = 0x8000;
const FILTER_TABLE_AT = DATA_SEGMENT + 0xe0;

/** A guest memory image with helpers to place samples and a command list. */
class Machine {
  ram = new Uint8Array(RAM_SIZE);
  dv = new DataView(this.ram.buffer);
  synth = new Synth();

  s16(addr: number, values: readonly number[]): void {
    values.forEach((v, i) => this.dv.setInt16(addr + i * 2, v));
  }

  readS16(addr: number, n: number): number[] {
    return Array.from({ length: n }, (_, i) => this.dv.getInt16(addr + i * 2));
  }

  /** Samples held in the working memory. */
  dm(addr: number, n: number): number[] {
    const dv = new DataView(this.synth.dmem.buffer);
    return Array.from({ length: n }, (_, i) => dv.getInt16(addr + i * 2));
  }

  run(commands: ReadonlyArray<readonly [number, number]>): void {
    commands.forEach(([w0, w1], i) => {
      this.dv.setUint32(LIST + i * 8, w0 >>> 0);
      this.dv.setUint32(LIST + i * 8 + 4, w1 >>> 0);
    });
    this.synth.run(this.ram, { list: LIST, size: commands.length * 8, dataSegment: DATA_SEGMENT });
  }
}

// Commands, as the microcode decodes them (docs/re/audio.md).
const load = (dmem: number, ram: number, bytes: number): [number, number] => [0x14000000 | ((bytes >> 4) << 16) | dmem, ram];
const save = (dmem: number, ram: number, bytes: number): [number, number] => [0x15000000 | ((bytes >> 4) << 16) | dmem, ram];
const setBuffer = (inAddr: number, outAddr: number, count: number): [number, number] => [0x08000000 | inAddr, (outAddr << 16) | count];
const adpcm = (flags: number, state: number): [number, number] => [0x01000000 | (flags << 16), state];
const loadBook = (ram: number, bytes: number): [number, number] => [0x0b000000 | bytes, ram];
const resample = (flags: number, pitch: number, state: number): [number, number] => [0x05000000 | (flags << 16) | pitch, state];
const mixCmd = (gain: number, count: number, src: number, dst: number): [number, number] => [0x0c000000 | ((count >> 4) << 16) | (gain & 0xffff), (src << 16) | dst];

describe('ADPCM decoding', () => {
  const BOOK = 0x2000, FRAME = 0x2100, STATE = 0x2200;

  /** Decodes one 16-sample frame whose predictor is the given 16 coefficients. */
  function decode(book: readonly number[], header: number, nibbles: readonly number[], flags = 1): Machine {
    const m = new Machine();
    m.s16(BOOK, book);
    m.ram[FRAME] = header;
    for (let i = 0; i < 8; i++) m.ram[FRAME + 1 + i] = (nibbles[i * 2]! << 4) | nibbles[i * 2 + 1]!;
    m.run([loadBook(BOOK, 32), load(0x400, FRAME, 16), setBuffer(0x400, 0x600, 32), adpcm(flags, STATE)]);
    return m;
  }

  const NIBBLES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  const SIGNED = NIBBLES.map((n) => (n > 7 ? n - 16 : n));

  it('scales signed nibbles by two to the power of the header scale when the predictor is silent', () => {
    const m = decode(new Array(16).fill(0), 0x30, NIBBLES);
    expect(m.dm(0x620, 16)).toEqual(SIGNED.map((n) => n * 8));
  });

  it('adds the previous input through the second codebook row', () => {
    // Row 1 starting with 1.0 (2048) makes every sample the sum of its input and the input before; the first of each half
    // adds the output before it instead (zero for the first half after an initialising run).
    const book = new Array(16).fill(0);
    book[8] = 2048;
    const m = decode(book, 0x10, NIBBLES);
    const ins = SIGNED.map((n) => n * 2);
    const expected = ins.map((x, i) => (i % 8 === 0 ? x : x + ins[i - 1]!));
    expected[8] = ins[8]! + expected[7]!;
    expect(m.dm(0x620, 16)).toEqual(expected);
  });

  it('clamps to 16 bits', () => {
    const book = new Array(16).fill(0);
    const m = decode(book, 0xc0, [7, 7, 8, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(m.dm(0x620, 4)).toEqual([7 << 12, 7 << 12, -8 << 12, -8 << 12]);
  });

  it('saves the last 16 samples as the state and continues from them', () => {
    // Row 0 starting with 1.0 carries the second-to-last previous sample into the first sample of each half.
    const book = new Array(16).fill(0);
    book[0] = 2048;
    const m = decode(book, 0x00, new Array(16).fill(7));
    // The second half also adds the first half's second-to-last sample.
    const first = [...new Array(8).fill(7), 14, ...new Array(7).fill(7)];
    expect(m.dm(0x620, 16)).toEqual(first);
    expect(m.readS16(STATE, 16)).toEqual(first);
    m.ram.fill(0, FRAME, FRAME + 9);
    m.run([load(0x400, FRAME, 16), setBuffer(0x400, 0x600, 32), adpcm(0, STATE)]);
    // The first half starts from the saved state, the second from the first half's own zeros.
    expect(m.dm(0x620, 16)).toEqual([7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(m.readS16(STATE, 16)).toEqual(m.dm(0x620, 16));
  });

  it('decodes the two-bit format with five bytes per frame', () => {
    const m = new Machine();
    m.s16(BOOK, new Array(16).fill(0));
    m.ram.set([0x20, 0b00_01_10_11, 0b01_01_01_01, 0, 0], FRAME);
    m.run([loadBook(BOOK, 32), load(0x400, FRAME, 16), setBuffer(0x400, 0x600, 32), adpcm(1 | 4, STATE)]);
    // Two-bit values are -2..1 scaled by 2^scale.
    expect(m.dm(0x620, 4)).toEqual([0, 1 << 2, -2 << 2, -1 << 2]);
    expect(m.dm(0x628, 4)).toEqual([1 << 2, 1 << 2, 1 << 2, 1 << 2]);
  });
});

describe('resampling', () => {
  const STATE = 0x2200, SAMPLES = 0x2000;

  /** A filter whose every entry passes the sample at offset 3 of its four-sample window, scaled by 0x7fff. */
  function passFilter(m: Machine): void {
    for (let i = 0; i < 64; i++) m.s16(FILTER_TABLE_AT + i * 8, [0, 0, 0, 0x7fff]);
  }

  it('reproduces its input one sample late at the unit rate', () => {
    const m = new Machine();
    passFilter(m);
    const input = Array.from({ length: 32 }, (_, i) => (i + 1) * 500);
    m.s16(SAMPLES, input);
    m.run([load(0x400, SAMPLES, 64), setBuffer(0x400, 0x800, 32 * 2), resample(1, 0x8000, STATE)]);
    const out = m.dm(0x800, 32);
    for (let n = 1; n < 32; n++) expect(Math.abs(out[n]! - input[n - 1]!)).toBeLessThanOrEqual(1);
    expect(out[0]).toBe(0);
  });

  it('advances through the input at the rate the pitch gives', () => {
    const m = new Machine();
    passFilter(m);
    const input = Array.from({ length: 32 }, (_, i) => (i + 1) * 500);
    m.s16(SAMPLES, input);
    // Half speed: each input sample is held for two outputs.
    m.run([load(0x400, SAMPLES, 64), setBuffer(0x400, 0x800, 32 * 2), resample(1, 0x4000, STATE)]);
    const out = m.dm(0x800, 16);
    for (let n = 2; n < 16; n++) expect(Math.abs(out[n]! - input[Math.floor(n / 2) - 1]!)).toBeLessThanOrEqual(1);
  });

  it('keeps the position and the last samples across runs', () => {
    const input = Array.from({ length: 64 }, (_, i) => (i + 1) * 300);
    const whole = new Machine();
    passFilter(whole);
    whole.s16(SAMPLES, input);
    whole.run([load(0x400, SAMPLES, 128), setBuffer(0x400, 0x800, 64), resample(1, 0xa000, STATE)]);

    // 1.25 input samples per output: 16 outputs consume exactly 20 samples, and the second run starts there.
    const split = new Machine();
    passFilter(split);
    split.s16(SAMPLES, input);
    split.run([load(0x400, SAMPLES, 128), setBuffer(0x400, 0x800, 32), resample(1, 0xa000, STATE)]);
    expect(split.dv.getUint16(STATE + 8)).toBe(0);
    split.run([load(0x400, SAMPLES + 40, 64), setBuffer(0x400, 0x820, 32), resample(0, 0xa000, STATE)]);
    expect(split.dm(0x800, 32)).toEqual(whole.dm(0x800, 32));
  });
});

describe('mixing', () => {
  it('adds the source scaled by the gain to the destination', () => {
    const m = new Machine();
    m.s16(0x2000, [1000, -1000, 30000, 0, 0, 0, 0, 0]);
    m.s16(0x2010, [2000, 4000, 30000, 100, 0, 0, 0, 0]);
    m.run([load(0x400, 0x2000, 16), load(0x500, 0x2010, 16), mixCmd(0x4000, 32, 0x500, 0x400)]);
    expect(m.dm(0x400, 4)).toEqual([2000, 1000, 32767, 50]);
  });

  it('subtracts when the gain is negative', () => {
    const m = new Machine();
    m.s16(0x2000, [1000, 0, 0, 0, 0, 0, 0, 0]);
    m.s16(0x2010, [1000, 0, 0, 0, 0, 0, 0, 0]);
    m.run([load(0x400, 0x2000, 16), load(0x500, 0x2010, 16), mixCmd(-0x4000, 32, 0x500, 0x400)]);
    expect(m.dm(0x400, 1)).toEqual([500]);
  });
});

// Command 0e (ucode+0xc5c-0xca8): the gain is w0 bits 16-23 as 4.4 fixed point.
const gainCmd = (gain: number, bytes: number, dmem: number): [number, number] => [0x0e000000 | (gain << 16) | bytes, dmem << 16];

describe('gain (command 0e)', () => {
  it('multiplies samples in place by a 4.4 fixed-point gain and saturates', () => {
    const m = new Machine();
    m.s16(0x2000, [1000, -1000, 20000, -20000, 7, -7, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
    m.run([load(0x400, 0x2000, 32), gainCmd(0x28, 32, 0x400)]);
    expect(m.dm(0x400, 8)).toEqual([2500, -2500, 32767, -32768, 17, -18, 0, 2]);
  });

  it('processes at least one 32-byte block and rounds the count up to whole blocks', () => {
    const m = new Machine();
    m.s16(0x2000, Array.from({ length: 48 }, () => 100));
    m.run([load(0x400, 0x2000, 96), gainCmd(0x20, 0, 0x400)]);
    expect(m.dm(0x400, 17)).toEqual([...Array(16).fill(200), 100]);
    m.run([load(0x400, 0x2000, 96), gainCmd(0x20, 33, 0x400)]);
    expect(m.dm(0x400, 33)).toEqual([...Array(32).fill(200), 100]);
  });
});

const romPath = process.env.OOT_ROM;

describe.skipIf(!romPath || !existsSync(romPath))('gain (command 0e) against the audio microcode', () => {
  it('writes the samples the microcode writes', () => {
    const code = buildSpecs(loadContext(romPath!)).find((s) => s.name === 'code')!;
    const at = (address: number, size: number) => code.bytes.subarray(address - code.base, address - code.base + size);
    const samples = [0, 1, -1, 7, -7, 1000, -1000, 2047, -2048, 2049, 20000, -20000, 32767, -32768, 12345, -12345];
    for (const gain of [0x01, 0x08, 0x10, 0x28, 0x5f, 0xff]) {
      const m = new Machine();
      m.ram.set(at(0x801120e0, 0x2e0), DATA_SEGMENT);
      m.s16(0x2000, [...samples, ...samples.map((x) => -x - 3)]);
      const commands = [load(0x400, 0x2000, 64), gainCmd(gain, 64, 0x400), save(0x400, 0x3000, 64)];
      const expected = m.ram.slice();
      commands.forEach(([w0, w1], i) => {
        new DataView(expected.buffer).setUint32(LIST + i * 8, w0 >>> 0);
        new DataView(expected.buffer).setUint32(LIST + i * 8 + 4, w1 >>> 0);
      });
      m.run(commands);
      new RspReference(at(0x800e0f10, 0x1000)).run(expected, { dataPtr: DATA_SEGMENT, dataSize: 0x2df, listPtr: LIST, listSize: commands.length * 8 });
      expect(m.readS16(0x3000, 32), `gain ${gain.toString(16)}`).toEqual(Array.from({ length: 32 }, (_, i) => new DataView(expected.buffer).getInt16(0x3000 + i * 2)));
    }
  });
});

describe('envelope mixing', () => {
  const setRates = (wetVolume: number, wetRate: number, rateL: number, rateR: number): [number, number] =>
    [0x12000000 | ((wetVolume >> 8) << 16) | wetRate, (rateL << 16) | rateR];
  const setVolumes = (volL: number, volR: number): [number, number] => [0x16000000, (volL << 16) | volR];
  const envMix = (flags: number, samples: number, input: number, dryL: number, dryR: number, wetL: number, wetR: number): [number, number] =>
    [0x13000000 | ((input >> 4) << 16) | (samples << 8) | flags, ((dryL >> 4) << 24) | ((dryR >> 4) << 16) | ((wetL >> 4) << 8) | (wetR >> 4)];

  it('sends the input to each output scaled by its volume', () => {
    const m = new Machine();
    const input = Array.from({ length: 16 }, (_, i) => (i + 1) * 1000);
    m.s16(0x2000, input);
    m.run([
      load(0x400, 0x2000, 32),
      setRates(0x4000, 0, 0, 0),
      setVolumes(0x8000, 0x4000),
      envMix(0, 16, 0x400, 0x600, 0x700, 0x800, 0x900),
    ]);
    expect(m.dm(0x600, 16)).toEqual(input.map((x) => Math.floor(x / 2)));
    expect(m.dm(0x700, 16)).toEqual(input.map((x) => Math.floor(x / 4)));
    // The wet outputs take their share of the dry ones.
    expect(m.dm(0x800, 16)).toEqual(input.map((x) => Math.floor(Math.floor(x / 2) / 4)));
    expect(m.dm(0x900, 16)).toEqual(input.map((x) => Math.floor(Math.floor(x / 4) / 4)));
  });

  it('adds to what the outputs already hold', () => {
    const m = new Machine();
    m.s16(0x2000, new Array(16).fill(1000));
    m.s16(0x2020, new Array(16).fill(500));
    m.run([
      load(0x400, 0x2000, 32),
      load(0x600, 0x2020, 32),
      setRates(0, 0, 0, 0),
      setVolumes(0x8000, 0),
      envMix(0, 16, 0x400, 0x600, 0x700, 0x800, 0x900),
    ]);
    expect(m.dm(0x600, 16)).toEqual(new Array(16).fill(1000));
  });

  it('changes the volume by the rate once per eight samples', () => {
    const m = new Machine();
    m.s16(0x2000, new Array(32).fill(0x4000));
    m.run([
      load(0x400, 0x2000, 64),
      setRates(0, 0, 0x1000, 0),
      setVolumes(0x1000, 0),
      envMix(0, 32, 0x400, 0x600, 0x700, 0x800, 0x900),
    ]);
    const out = m.dm(0x600, 32);
    expect(out.slice(0, 8)).toEqual(new Array(8).fill(0x400));
    expect(out.slice(8, 16)).toEqual(new Array(8).fill(0x800));
    expect(out.slice(16, 24)).toEqual(new Array(8).fill(0xc00));
  });
});

describe('buffer commands', () => {
  it('moves, clears, decimates and interleaves in the working memory', () => {
    const m = new Machine();
    m.s16(0x2000, Array.from({ length: 16 }, (_, i) => i + 1));
    m.run([
      load(0x400, 0x2000, 32),
      [0x0a000400, (0x500 << 16) | 32],
      [0x02000000 | 0x410, 16],
      [0x11000000 | 8, (0x400 << 16) | 0x600],
      [0x0d000000 | 0x700 | (16 >> 4 << 16), (0x400 << 16) | 0x500],
    ]);
    expect(m.dm(0x500, 16)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    expect(m.dm(0x400, 16)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(m.dm(0x600, 8)).toEqual([1, 3, 5, 7, 0, 0, 0, 0]);
    expect(m.dm(0x700, 16)).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8]);
  });

  it('repeats a 128-byte block and copies runs of bytes', () => {
    const m = new Machine();
    m.s16(0x2000, Array.from({ length: 64 }, (_, i) => i + 1));
    m.run([
      load(0x400, 0x2000, 128),
      [0x09020000 | 0x400, 0x500 << 16],
      [0x10010000 | 0x400, (0x700 << 16) | 64],
    ]);
    const block = Array.from({ length: 64 }, (_, i) => i + 1);
    expect(m.dm(0x500, 64)).toEqual(block);
    expect(m.dm(0x580, 64)).toEqual(block);
    expect(m.dm(0x700, 32)).toEqual(block.slice(0, 32));
    expect(() => m.run([[0x09010000 | 0x408, 0x500 << 16]])).toThrow(/multiple of 16/);
  });

  it('writes the working memory back to the guest', () => {
    const m = new Machine();
    m.s16(0x2000, [1, 2, 3, 4, 5, 6, 7, 8]);
    m.run([load(0x400, 0x2000, 16), save(0x400, 0x3000, 16)]);
    expect(m.readS16(0x3000, 8)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('rejects a command it does not know', () => {
    const m = new Machine();
    expect(() => m.run([[0x7e000000, 0]])).toThrow(/unknown audio command 0x7e/);
  });
});

describe('the FIR filter', () => {
  const COEFFICIENTS = 0x2000, STATE = 0x2100, SAMPLES = 0x2200;
  const loadCoefficients = (count: number): [number, number] => [0x07020000 | count, COEFFICIENTS];
  const run = (flags: number, buffer: number): [number, number] => [0x07000000 | (flags << 16) | buffer, STATE];

  it('applies the coefficients as a convolution with the history of the buffer before', () => {
    const m = new Machine();
    // Taps 0 and 1: out[n] = c0 * x[n] + c1 * x[n-1]. The coefficients used are the mean of the loaded ones and the
    // state's, which is zero after an initialising run, so loading twice the wanted value gives it.
    m.s16(COEFFICIENTS, [0x7ffe, 0x2000, 0, 0, 0, 0, 0, 0]);
    const input = Array.from({ length: 16 }, (_, i) => (i + 1) * 1000);
    m.s16(SAMPLES, input);
    m.run([load(0x400, SAMPLES, 32), loadCoefficients(32), run(1, 0x400)]);
    const out = m.dm(0x400, 16);
    expect(out[0]).toBe(Math.floor((1000 * 0x3fff * 2 + 0x8000) / 65536));
    for (let n = 1; n < 16; n++) {
      const expected = Math.floor((input[n]! * 0x3fff * 2 + input[n - 1]! * 0x1000 * 2 + 0x8000) / 65536);
      expect(out[n]).toBe(expected);
    }
  });
});
