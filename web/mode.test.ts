import { describe, expect, it } from 'vitest';
import { frameMs, FramePacer, loadHz, saveHz, type PreferenceStore } from './mode.ts';

function memory(): PreferenceStore & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return { items, getItem: (k) => items.get(k) ?? null, setItem: (k, v) => void items.set(k, v) };
}

describe('the remembered rate', () => {
  it('is 50 Hz until 60 Hz is chosen, and then survives a reload', () => {
    const store = memory();
    expect(loadHz(store)).toBe(50);
    expect(saveHz(60, store)).toBe(true);
    expect(loadHz(store)).toBe(60);
    saveHz(50, store);
    expect(loadHz(store)).toBe(50);
  });

  it('falls back to 50 Hz when storage is missing or throws', () => {
    const broken: PreferenceStore = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    };
    expect(loadHz(broken)).toBe(50);
    expect(saveHz(60, broken)).toBe(false);
    expect(loadHz(null)).toBe(50);
    expect(saveHz(60, null)).toBe(false);
  });
});

describe('FramePacer', () => {
  it('lasts 20 ms per frame at 50 Hz and 1/60 s at 60 Hz', () => {
    expect(frameMs(50)).toBe(20);
    expect(frameMs(60)).toBeCloseTo(16.667, 3);
  });

  it('runs 50 frames in a second at 50 Hz and 60 at 60 Hz, whatever the display interval', () => {
    for (const hz of [50, 60] as const) {
      for (const tick of [8, 16.667, 33]) {
        const pacer = new FramePacer(hz);
        let frames = 0;
        for (let t = 0; t < 10_000; t += tick) frames += pacer.advance(tick);
        expect(frames / 10).toBeCloseTo(hz, 0);
      }
    }
  });

  it('carries the part of a frame that has not elapsed yet', () => {
    const pacer = new FramePacer(60);
    expect(pacer.advance(10)).toBe(0);
    expect(pacer.advance(10)).toBe(1);
    expect(pacer.advance(10)).toBe(0);
  });

  it('catches up by three frames at most after a stall', () => {
    for (const hz of [50, 60] as const) {
      const pacer = new FramePacer(hz);
      expect(pacer.advance(5000)).toBe(3);
      expect(pacer.advance(0)).toBe(0);
    }
  });

  it('forgets the debt on reset', () => {
    const pacer = new FramePacer(50);
    pacer.advance(15);
    pacer.reset();
    expect(pacer.advance(10)).toBe(0);
  });
});
