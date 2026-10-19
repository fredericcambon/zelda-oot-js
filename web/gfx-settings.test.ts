import { describe, expect, it } from 'vitest';
import { defaultSettings, MAX_SCALE, parseSettings, renderScale } from './gfx-settings.ts';

describe('graphics settings', () => {
  it('falls back to the defaults for missing, broken or invalid stored values', () => {
    expect(parseSettings(null, false)).toEqual(defaultSettings(false));
    expect(parseSettings('{not json', false)).toEqual(defaultSettings(false));
    expect(parseSettings('{"filter":"blurry","cutout":"soft","lightingMode":"flat","msaa":3,"scaleCap":-1,"anisotropy":99,"ao":1,"aoStrength":101,"bloom":1,"bloomStrength":101,"bloomThreshold":"x","bloomKnee":-5,"bloomRadius":500,"sharpen":"on","sharpenStrength":-1}', false)).toEqual(defaultSettings(false));
  });

  it('keeps valid stored values', () => {
    const stored = { filter: 'sharp', msaa: false, scaleCap: 1.5, mipmaps: false, anisotropy: 8, cutout: 'hard', lightingMode: 'pixel', ao: false, aoStrength: 65, bloom: false, bloomStrength: 55, bloomThreshold: 70, bloomKnee: 0, bloomRadius: 50, sharpen: false, sharpenStrength: 0 };
    expect(parseSettings(JSON.stringify(stored), false)).toEqual(stored);
  });

  it('caps the scale on mobile by default only', () => {
    expect(defaultSettings(true).scaleCap).toBe(2);
    expect(defaultSettings(false).scaleCap).toBe(0);
  });

  it('renders at the canvas size in device pixels', () => {
    const desktop = defaultSettings(false);
    expect(renderScale(960, 1, desktop)).toBe(3);
    expect(renderScale(960, 1.5, desktop)).toBe(4.5);
    expect(renderScale(960, 3, defaultSettings(true))).toBe(6);
    expect(renderScale(960, 3, { ...desktop, scaleCap: 2 })).toBe(6);
  });

  it('stays between native size and the largest scale', () => {
    expect(renderScale(100, 1, defaultSettings(false))).toBe(1);
    expect(renderScale(8000, 2, defaultSettings(false))).toBe(MAX_SCALE);
    expect(renderScale(NaN, 1, defaultSettings(false))).toBe(1);
  });
});
