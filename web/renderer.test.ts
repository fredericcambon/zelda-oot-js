import { describe, expect, it } from 'vitest';
import { decodeCombine, type DrawState, type TriangleBatch } from '../tools/gfx/types.ts';
import { Renderer } from './renderer.ts';

/** A WebGL2 context that records what is bound to each texture unit and which texture each upload went to. */
function fakeContext() {
  const log = { active: 0, bound: new Map<number, object>(), uploads: new Map<object, number[]>(), atDraw: [] as (object | undefined)[][] };
  let textures = 0;
  const target = {
    createTexture: () => ({ id: ++textures }),
    activeTexture: (unit: number) => { log.active = unit - 0x84c0; },
    bindTexture: (_: number, t: object | null) => { if (t) log.bound.set(log.active, t); else log.bound.delete(log.active); },
    texImage2D: (...args: unknown[]) => {
      const pixels = args[args.length - 1] as Uint8Array | null;
      if (pixels) log.uploads.set(log.bound.get(log.active)!, Array.from(pixels.slice(0, 1)));
    },
    drawArrays: () => { log.atDraw.push([0, 1].map((u) => log.bound.get(u))); },
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getUniformLocation: () => ({}),
  };
  const gl = new Proxy(target, {
    get: (t, key: string) => (key in t ? (t as Record<string, unknown>)[key] : key === 'TEXTURE0' ? 0x84c0 : key.toUpperCase() === key ? 1 : () => ({})),
  });
  return { gl, log };
}

const rgba = { r: 0, g: 0, b: 0, a: 0 };
function state(textures: [number, number]): DrawState {
  const tile = { fmt: 0, siz: 3, line: 0, tmem: 0, palette: 0, cmT: 0, maskT: 0, shiftT: 0, cmS: 0, maskS: 0, shiftS: 0, uls: 0, ult: 0, lrs: 0, lrt: 0, sized: true };
  const image = (value: number, index: number) => ({ id: value, width: 1, height: 1, rgba: Uint8Array.of(value, 0, 0, 255), tile: index });
  return {
    geometryMode: 0, otherModeH: 0, otherModeL: 0, combine: decodeCombine(0, 0), primColor: { ...rgba, minLod: 0, lodFrac: 0 },
    envColor: rgba, fogColor: rgba, blendColor: rgba, fillColor: 0, texture: { on: true, level: 0, tile: 0, scaleS: 0, scaleT: 0 },
    tiles: [tile, tile], textures: [image(textures[0], 0), image(textures[1], 1)], viewport: { scale: [0, 0, 0], trans: [0, 0, 0] },
    scissor: { mode: 0, xh: 0, yh: 0, xl: 0, yl: 0 }, colorImage: { fmt: 0, siz: 2, width: 320, addr: 0x80100000 }, depthImage: 0,
  };
}

describe('renderer textures', () => {
  // Uploading a texture binds it on some unit; if that is the unit of the first tile, the first tile samples the second tile's
  // picture whenever the second tile's texture is new (the forest's ladder came out black this way).
  it('keeps each tile on its own texture unit when the second tile has a texture the first draw has not seen', () => {
    const { gl, log } = fakeContext();
    const canvas = { width: 0, height: 0, getContext: () => gl } as unknown as HTMLCanvasElement;
    const renderer = new Renderer(canvas);
    const batch: TriangleBatch = {
      kind: 'triangles', state: state([10, 20]),
      positions: Float32Array.of(-1, -1, 0, 1, 1, -1, 0, 1, 0, 1, 0, 1), colors: new Float32Array(12).fill(1), uvs: new Float32Array(6),
    };
    renderer.drawTask({ batches: [batch], commands: 0, opcodes: new Map(), unknown: [], problems: [] });
    const [first, second] = log.atDraw.at(-1)!;
    expect(log.uploads.get(first!)).toEqual([10]);
    expect(log.uploads.get(second!)).toEqual([20]);
  });
});
