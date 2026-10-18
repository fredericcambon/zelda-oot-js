import { describe, expect, it } from 'vitest';
import type { DrawState } from '../gfx/types.ts';
import { texturesRead } from './used.ts';

const ZERO: [number, number, number, number] = [0, 0, 0, 0];
const state = (cycle: number, c0: { rgb?: number[]; alpha?: number[] }, c1: { rgb?: number[]; alpha?: number[] } = {}): DrawState =>
  ({
    otherModeH: cycle << 20,
    combine: { cycles: [{ rgb: c0.rgb ?? ZERO, alpha: c0.alpha ?? ZERO }, { rgb: c1.rgb ?? ZERO, alpha: c1.alpha ?? ZERO }] },
  }) as unknown as DrawState;

describe('texturesRead', () => {
  it('reads the first texture in one-cycle mode through TEXEL0 and the second through TEXEL1, colour or alpha', () => {
    expect(texturesRead(state(0, { rgb: [1, 0, 4, 0] }))).toEqual([true, false]);
    expect(texturesRead(state(0, { rgb: [4, 0, 9, 0] }))).toEqual([false, true]);
    expect(texturesRead(state(0, { rgb: [0, 0, 0, 3], alpha: [0, 0, 2, 0] }))).toEqual([false, true]);
    expect(texturesRead(state(0, { rgb: [0, 0, 8, 0] }))).toEqual([true, false]);
  });

  it('swaps the textures in the second cycle of two-cycle mode', () => {
    expect(texturesRead(state(1, { rgb: [1, 0, 4, 0] }, { rgb: [0, 0, 0, 0] }))).toEqual([true, false]);
    expect(texturesRead(state(1, { rgb: [0, 0, 0, 0] }, { rgb: [1, 0, 4, 0] }))).toEqual([false, true]);
    expect(texturesRead(state(1, { rgb: [1, 0, 4, 0] }, { rgb: [2, 0, 4, 0] }))).toEqual([true, false]);
  });

  it('reads only the first texture when copying and none when filling', () => {
    expect(texturesRead(state(2, {}))).toEqual([true, false]);
    expect(texturesRead(state(3, { rgb: [1, 0, 4, 0] }))).toEqual([false, false]);
  });
});
