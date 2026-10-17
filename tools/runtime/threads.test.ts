import { describe, expect, it } from 'vitest';
import { encodeThreads, parseThreads, THREADS_MAGIC, type ThreadsDescription } from './threads.ts';

const registers = (seed: bigint) => ({
  r: Array.from({ length: 32 }, (_, i) => seed + BigInt(i)),
  hi: 0xfffffffff0000001n,
  lo: 7n,
  llbit: 1,
  f: Array.from({ length: 32 }, (_, i) => seed * 3n + BigInt(i)),
  fcsr: 0x01000800,
  fir: 0,
  fr: 0,
});

const sample: ThreadsDescription = {
  running: 0,
  status: 0x2000ff01,
  intMask: 0xff01,
  threads: [
    {
      slot: 0, addr: 0x80300000, entry: 0x80100200, started: true, parked: false, registers: registers(10n), blockingSite: 1,
      frames: [
        { kind: 'site', image: 1, entry: 0x80100200, site: 0x80100210 },
        { kind: 'runtime', id: 0xf0000001, payload: [0x80900000, 0x80700000] },
        { kind: 'site', image: 0, entry: 0x80000498, site: 0x800004d0 },
      ],
    },
    { slot: 5, addr: 0x80300400, entry: 0x80100300, started: false, parked: false, registers: registers(50n), blockingSite: 0, frames: [] },
  ],
};

describe('thread descriptions', () => {
  it('read back as written', () => {
    expect(parseThreads(encodeThreads(sample))).toEqual(sample);
  });

  it('start with the magic number and hold little-endian words', () => {
    const bytes = encodeThreads(sample);
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x54, 0x48, 0x52, 0x44]);
    expect(new DataView(bytes.buffer).getUint32(0, true)).toBe(THREADS_MAGIC);
  });

  it('are refused when cut short, padded or not descriptions at all', () => {
    const bytes = encodeThreads(sample);
    expect(() => parseThreads(bytes.subarray(0, bytes.length - 4))).toThrow(/cut short/);
    expect(() => parseThreads(new Uint8Array([...bytes, 0, 0, 0, 0]))).toThrow(/trailing/);
    const other = bytes.slice();
    other[0] = other[0]! ^ 1;
    expect(() => parseThreads(other)).toThrow(/not a thread description/);
  });
});
