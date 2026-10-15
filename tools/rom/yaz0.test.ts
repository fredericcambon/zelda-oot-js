import { describe, expect, it } from 'vitest';
import { yaz0Decode } from './yaz0.ts';

function stream(size: number, body: number[]): Uint8Array {
  const head = [0x59, 0x61, 0x7a, 0x30, size >>> 24, (size >> 16) & 255, (size >> 8) & 255, size & 255];
  return Uint8Array.from([...head, 0, 0, 0, 0, 0, 0, 0, 0, ...body]);
}

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

describe('yaz0Decode', () => {
  it('decodes literals', () => {
    const out = yaz0Decode(stream(3, [0xe0, ...ascii('abc')]));
    expect(Array.from(out)).toEqual(ascii('abc'));
  });

  it('decodes a short back reference (length from the high nibble)', () => {
    // literals A B C, copy 6 bytes from distance 3, literal X
    const out = yaz0Decode(stream(10, [0xe8, ...ascii('ABC'), 0x40, 0x02, ...ascii('X')]));
    expect(String.fromCharCode(...out)).toBe('ABCABCABCX');
  });

  it('decodes a long back reference (length from a third byte)', () => {
    // literal Z, copy 0x12 + 0x10 = 34 bytes from distance 1 (overlapping copy)
    const out = yaz0Decode(stream(35, [0x80, ...ascii('Z'), 0x00, 0x00, 0x10]));
    expect(String.fromCharCode(...out)).toBe('Z'.repeat(35));
  });

  it('uses the 12-bit distance', () => {
    const lits = Array.from({ length: 304 }, (_, i) => (i * 7 + 1) & 255);
    const body: number[] = [];
    for (let i = 0; i < lits.length; i += 8) body.push(0xff, ...lits.slice(i, i + 8));
    // copy 3 bytes from distance 300: N=1 (length 3), distance-1 = 299 = 0x12b
    body.push(0x00, 0x11, 0x2b);
    const out = yaz0Decode(stream(307, body));
    expect(Array.from(out.subarray(304))).toEqual(lits.slice(4, 7));
  });

  it('honours an offset into a larger buffer', () => {
    const s = stream(1, [0x80, 0x41]);
    const padded = Uint8Array.from([9, 9, 9, ...s]);
    expect(Array.from(yaz0Decode(padded, 3))).toEqual([0x41]);
  });

  it('rejects bad input', () => {
    expect(() => yaz0Decode(Uint8Array.from(ascii('Nope0000000000000000')))).toThrow(/magic/);
    expect(() => yaz0Decode(stream(4, [0xe0, ...ascii('ab')]))).toThrow(/truncated/);
    expect(() => yaz0Decode(stream(4, [0x00, 0x10, 0x00]))).toThrow(/before start/);
    expect(() => yaz0Decode(stream(3, [0x80, ...ascii('A'), 0x40, 0x00]))).toThrow(/overflows/);
  });
});
