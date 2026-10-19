import { describe, expect, it } from 'vitest';
import { offscreenRegions, writeRegion } from './offscreen.ts';
import { decodeCombine, type DrawState, type RectBatch } from './types.ts';
import { SoftRenderer } from './raster.ts';

const rgba = { r: 0, g: 0, b: 0, a: 0 };
const tile = { fmt: 0, siz: 2, line: 16, tmem: 0, palette: 0, cmT: 0, maskT: 0, shiftT: 0, cmS: 0, maskS: 0, shiftS: 0, uls: 0, ult: 0, lrs: 0, lrt: 0, sized: true };

function state(over: Partial<DrawState> = {}): DrawState {
  return {
    geometryMode: 0, otherModeH: 0x382c30, otherModeL: 0, combine: decodeCombine(0, 0), primColor: { ...rgba, minLod: 0, lodFrac: 0 },
    envColor: rgba, fogColor: rgba, blendColor: rgba, fillColor: 0xf801f801, texture: { on: false, level: 0, tile: 0, scaleS: 0, scaleT: 0 },
    tiles: [tile], textures: [null, null], viewport: { scale: [0, 0, 0], trans: [0, 0, 0] }, scissor: { mode: 0, xh: 0, yh: 0, xl: 256, yl: 448 },
    colorImage: { fmt: 0, siz: 2, width: 64, addr: 0x287d40 }, depthImage: 0x129e80, ...over,
  };
}

const fill = (s: DrawState, xh: number, yh: number, xl: number, yl: number): RectBatch => ({ kind: 'fillrect', state: s, xh, yh, xl, yl, tile: 0, s: 0, t: 0, dsdx: 0, dtdy: 0 });

describe('offscreen colour images', () => {
  it('names the images that are neither screens nor the depth buffer, with the part drawn', () => {
    const batches = [
      fill(state(), 0, 0, 252, 444),
      fill(state({ colorImage: { fmt: 0, siz: 2, width: 320, addr: 0x3da800 } }), 0, 0, 1276, 956),
      fill(state({ colorImage: { fmt: 0, siz: 2, width: 320, addr: 0x129e80 } }), 0, 0, 1276, 956),
      fill(state({ colorImage: { fmt: 4, siz: 1, width: 64, addr: 0x36c9a0 } }), 0, 0, 252, 444),
    ];
    expect(offscreenRegions(batches, (addr) => addr === 0x3da800)).toEqual([{ addr: 0x287d40, width: 64, x0: 0, y0: 0, x1: 64, y1: 112 }]);
  });

  it('writes RGBA5551 halfwords, top row first, big-endian', () => {
    const ram = new Uint8Array(0x287d40 + 64);
    writeRegion(ram, { addr: 0x287d40, width: 4, x0: 1, y0: 0, x1: 3, y1: 2 }, Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255));
    expect([...ram.subarray(0x287d40, 0x287d40 + 16)]).toEqual([0, 0, 0xf8, 0x01, 0x07, 0xc0, 0, 0, 0, 0, 0x00, 0x3f, 0xff, 0xff, 0, 0]);
  });
});

describe('the soft renderer', () => {
  it('copies non-screen colour images into the memory', () => {
    const soft = new SoftRenderer();
    const red = state({ otherModeH: 0x382c30, colorImage: { fmt: 0, siz: 2, width: 64, addr: 0x287d40 }, fillColor: 0xf801f801 });
    const memory = new Uint8Array(0x400000);
    soft.drawTask({ batches: [fill(red, 0, 0, 252, 444)], commands: 0, opcodes: new Map(), unknown: [], problems: [] }, memory);
    expect(memory.subarray(0x287d40, 0x287d44)).toEqual(Uint8Array.of(0xf8, 0x01, 0xf8, 0x01));
    expect(soft.images.get(0x287d40)![0]).toBe(255);
  });
});
