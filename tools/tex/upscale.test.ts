import { describe, expect, it } from 'vitest';
import type { TextureRecord } from './collect.ts';
import { skipReason } from './upscale.ts';

const texture = { hash: 'aaaaaaaaaaaaaaaa', width: 32, height: 32, frames: 10, volatile: false } as TextureRecord;

describe('skipReason', () => {
  it('keeps a plain texture and leaves an excluded one original with the reason', () => {
    expect(skipReason(texture)).toBeNull();
    expect(skipReason(texture, { aaaaaaaaaaaaaaaa: 'ink outlines' })).toBe('excluded: ink outlines');
    expect(skipReason(texture, { bbbbbbbbbbbbbbbb: 'other' })).toBeNull();
  });
});
