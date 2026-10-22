import { describe, expect, it } from 'vitest';
import type { Batch } from '../tools/gfx/types.ts';
import { logoAlpha, LOGO_ALPHA, titleFade } from './title-edition.ts';

function texrect(width: number, height: number, rgba: [number, number, number, number], fmt = 4, siz = 1): Batch {
  return {
    kind: 'texrect',
    state: { textures: [{ width, height, fmt, siz }, null], primColor: { r: rgba[0], g: rgba[1], b: rgba[2], a: rgba[3] } },
  } as unknown as Batch;
}

const subtitle = (alpha: number) => texrect(96, 8, [200, 200, 150, alpha]);
const shadow = (alpha: number) => texrect(96, 8, [0, 0, 0, alpha]);

describe('logoAlpha', () => {
  it('reads the alpha of the subtitle draw, not of its shadow pass', () => {
    expect(logoAlpha([shadow(90), subtitle(60)])).toBe(60);
  });

  it('is 0 when the list has no subtitle draw', () => {
    expect(logoAlpha([])).toBe(0);
    expect(logoAlpha([shadow(210), texrect(72, 8, [200, 200, 150, 210]), texrect(96, 8, [200, 200, 150, 210], 0, 3)])).toBe(0);
    expect(logoAlpha([{ kind: 'triangles', state: {} } as unknown as Batch])).toBe(0);
  });
});

describe('titleFade', () => {
  it('fades in with the logo and holds once it is at full alpha', () => {
    expect(titleFade(6, 1)).toBeCloseTo(6 / LOGO_ALPHA);
    expect(titleFade(105, 1)).toBeCloseTo(0.5);
    expect(titleFade(LOGO_ALPHA, 1)).toBe(1);
    expect(titleFade(255, 1)).toBe(1);
  });

  it('keeps following the logo while it fades out after Start (mode 2)', () => {
    expect(titleFade(185, 2)).toBeCloseTo(185 / LOGO_ALPHA);
    expect(titleFade(10, 2)).toBeCloseTo(10 / LOGO_ALPHA);
  });

  it('is hidden when the logo is not drawn, and in play', () => {
    expect(titleFade(0, 1)).toBe(0);
    expect(titleFade(0, 2)).toBe(0);
    expect(titleFade(LOGO_ALPHA, 0)).toBe(0);
  });
});
