import { describe, expect, it } from 'vitest';
import type { TextureRecord } from './collect.ts';
import { analyzeMoving } from './moving.ts';

const A = 'aaaaaaaaaaaaaaaa', B = 'bbbbbbbbbbbbbbbb', C = 'cccccccccccccccc';

describe('analyzeMoving', () => {
  it('counts flicker, pending draws and unresolved textures with their reasons', () => {
    const dump = new Map([[B, { hash: B, width: 8, height: 8, frames: 1, volatile: false } as TextureRecord]]);
    const report = analyzeMoving(
      [[`${A}~`, `${B}-`], [`${A}+`, `${C}-`], [`${A}-`, `${B}-`], [`${A}+`]],
      { [A]: { width: 8, height: 8, fmt: 0, siz: 2, unloaded: 0 }, [C]: { width: 32, height: 32, fmt: 0, siz: 2, unloaded: 512 } },
      dump,
    );
    expect(report).toMatchObject({ tasks: 4, textures: 3, inPack: 1, flickering: [A], pendingDraws: 1 });
    expect(report.unresolved).toEqual([
      { hash: A, tasks: 1, reason: 'not in the dump (8x8, format 0.2, 0 texels not loaded)' },
      { hash: B, tasks: 2, reason: 'in the dump, left original: seen in 1 graphics task(s) only' },
      { hash: C, tasks: 1, reason: 'not in the dump (32x32, format 0.2, 512 texels not loaded)' },
    ]);
  });
});
