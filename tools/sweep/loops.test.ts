import { describe, expect, it } from 'vitest';
import { findShortLoop } from './loops.ts';

const noise = (n: number, seed: number) => {
  let x = seed;
  return Int16Array.from({ length: n }, () => ((x = (Math.imul(x, 1103515245) + 12345) >>> 0) >>> 16) - 32768);
};

describe('short loop detection', () => {
  it('finds a stretch that repeats exactly', () => {
    const unit = noise(1000, 1);
    const pcm = Int16Array.from({ length: 60000 }, (_, i) => unit[i % 1000]!);
    expect(findShortLoop(pcm)).toEqual({ period: 1000 });
  });

  it('does not report music-like output, silence or a constant', () => {
    expect(findShortLoop(noise(60000, 2))).toBeUndefined();
    expect(findShortLoop(new Int16Array(60000))).toBeUndefined();
    expect(findShortLoop(new Int16Array(60000).fill(9000))).toBeUndefined();
  });

  it('does not report a tone whose period is not a whole number of samples', () => {
    const pcm = Int16Array.from({ length: 60000 }, (_, i) => Math.round(8000 * Math.sin((2 * Math.PI * i * 440.3) / 31995)));
    expect(findShortLoop(pcm)).toBeUndefined();
  });

  it('needs enough output to compare', () => {
    expect(findShortLoop(noise(1000, 3))).toBeUndefined();
  });
});
