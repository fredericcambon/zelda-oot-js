import { describe, expect, it } from 'vitest';
import { detectByteOrder, toBigEndian } from './byteorder.ts';

const z64 = Uint8Array.from([0x80, 0x37, 0x12, 0x40, 1, 2, 3, 4]);
const v64 = Uint8Array.from([0x37, 0x80, 0x40, 0x12, 2, 1, 4, 3]);
const n64 = Uint8Array.from([0x40, 0x12, 0x37, 0x80, 4, 3, 2, 1]);

describe('byte order', () => {
  it('detects each format from the header word', () => {
    expect(detectByteOrder(z64)).toBe('z64');
    expect(detectByteOrder(v64)).toBe('v64');
    expect(detectByteOrder(n64)).toBe('n64');
  });

  it('converts every format to big-endian', () => {
    expect(toBigEndian(z64)).toEqual(z64);
    expect(toBigEndian(v64)).toEqual(z64);
    expect(toBigEndian(n64)).toEqual(z64);
  });

  it('does not alias the input', () => {
    const out = toBigEndian(z64);
    out[0] = 0;
    expect(z64[0]).toBe(0x80);
  });

  it('rejects unknown data and ragged sizes', () => {
    expect(() => detectByteOrder(Uint8Array.from([1, 2, 3, 4]))).toThrow(/unrecognised/);
    expect(() => detectByteOrder(Uint8Array.from([1]))).toThrow(/too small/);
    expect(() => toBigEndian(Uint8Array.from([0x80, 0x37, 0x12, 0x40, 1]))).toThrow(/multiple of 4/);
  });
});
