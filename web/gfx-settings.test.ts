import { describe, expect, it } from 'vitest';
import { defaultSettings, MAX_SCALE, parseSettings, renderScale, type GfxSettings } from './gfx-settings.ts';

/** The settings as older versions stored them: without `maxScale`. */
const savedBeforeMaxScale = (settings: GfxSettings): Record<string, unknown> => Object.fromEntries(Object.entries(settings).filter(([key]) => key !== 'maxScale'));

describe('graphics settings', () => {
  it('falls back to the defaults for missing, broken or invalid stored values', () => {
    expect(parseSettings(null, false)).toEqual(defaultSettings(false));
    expect(parseSettings('{not json', false)).toEqual(defaultSettings(false));
    expect(parseSettings('{"filter":"blurry","cutout":"soft","lightingMode":"flat","msaa":3,"scaleCap":-1,"anisotropy":99,"ao":1,"aoStrength":101,"bloom":1,"bloomStrength":101,"bloomThreshold":"x","bloomKnee":-5,"bloomRadius":500,"sharpen":"on","sharpenStrength":-1,"pointLights":"yes","pointLightStrength":200}', false)).toEqual(defaultSettings(false));
  });

  it('keeps valid stored values', () => {
    const stored = { filter: 'sharp', msaa: false, scaleCap: 1.5, maxScale: 6, mipmaps: false, anisotropy: 8, cutout: 'hard', lightingMode: 'pixel', pointLights: true, pointLightStrength: 80, ao: false, aoStrength: 65, bloom: false, bloomStrength: 55, bloomThreshold: 70, bloomKnee: 0, bloomRadius: 50, sharpen: false, sharpenStrength: 0 };
    expect(parseSettings(JSON.stringify(stored), false)).toEqual(stored);
  });

  it('caps the scale on mobile by default only', () => {
    expect(defaultSettings(true).scaleCap).toBe(2);
    expect(defaultSettings(false).scaleCap).toBe(0);
  });

  it('turns the costly effects off by default on mobile only', () => {
    const mobile = defaultSettings(true);
    expect([mobile.ao, mobile.bloom, mobile.sharpen, mobile.msaa, mobile.anisotropy]).toEqual([false, false, false, false, 1]);
    const desktop = defaultSettings(false);
    expect([desktop.ao, desktop.bloom, desktop.sharpen, desktop.msaa, desktop.anisotropy]).toEqual([true, true, true, true, 4]);
  });

  it('moves phones that kept the old defaults to the new ones and keeps their own choices', () => {
    const old = savedBeforeMaxScale({ ...defaultSettings(false), scaleCap: 2, anisotropy: 2 });
    expect(parseSettings(JSON.stringify(old), true)).toEqual(defaultSettings(true));
    expect(parseSettings(JSON.stringify({ ...old, bloom: false }), true)).toEqual({ ...old, bloom: false, maxScale: 0 });
    expect(parseSettings(JSON.stringify(old), false)).toEqual({ ...old, maxScale: 0 });
  });

  it('renders at the canvas size in device pixels', () => {
    const desktop = defaultSettings(false);
    expect(renderScale(960, 1, desktop)).toBe(3);
    expect(renderScale(960, 1.5, desktop)).toBe(4.5);
    expect(renderScale(960, 3, defaultSettings(true))).toBe(6);
    expect(renderScale(960, 3, { ...desktop, scaleCap: 2, maxScale: 0 })).toBe(6);
  });

  it('caps the desktop image at 1080 lines whatever the device pixel ratio', () => {
    const desktop = defaultSettings(false);
    expect(desktop.maxScale).toBe(4.5);
    expect(renderScale(1470, 2, desktop)).toBe(4.5);
    expect(renderScale(1280, 1, desktop)).toBe(4);
    expect(renderScale(1470, 2, { ...desktop, maxScale: 8 })).toBe(8);
    expect(defaultSettings(true).maxScale).toBe(0);
  });

  it('gives settings saved before the cap existed the new cap, unless the user chose a ratio cap', () => {
    const old = savedBeforeMaxScale(defaultSettings(false));
    expect(parseSettings(JSON.stringify(old), false).maxScale).toBe(4.5);
    expect(parseSettings(JSON.stringify({ ...old, scaleCap: 3 }), false).maxScale).toBe(0);
  });

  it('stays between native size and the largest scale', () => {
    expect(renderScale(100, 1, defaultSettings(false))).toBe(1);
    expect(renderScale(8000, 2, { ...defaultSettings(false), maxScale: 0 })).toBe(MAX_SCALE);
    expect(renderScale(NaN, 1, defaultSettings(false))).toBe(1);
  });
});
