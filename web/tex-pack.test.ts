import { describe, expect, it, vi } from 'vitest';
import { decodeCombine, type DrawState, type TriangleBatch } from '../tools/gfx/types.ts';
import { hashTexture } from '../tools/tex/hash.ts';
import { Renderer } from './renderer.ts';
import { TexPack } from './tex-pack.ts';

const indexOf = (hashes: string[]) => ({ ok: true, json: async () => ({ textures: Object.fromEntries(hashes.map((h) => [h, {}])) }) }) as Response;

describe('TexPack', () => {
  it('stays empty when the server has no pack or answers with something else', async () => {
    for (const answer of [{ ok: false } as Response, { ok: true, json: async () => { throw new Error('html'); } } as unknown as Response]) {
      const pack = new TexPack('/texpack/', true);
      await pack.load(async () => answer);
      expect(pack.available).toBe(false);
      expect(pack.lookup('0123456789abcdef')).toBeNull();
    }
  });

  it('lists the pack and reports what the renderer looked up', async () => {
    const pack = new TexPack('/texpack/', true);
    const changed = vi.fn();
    pack.onChange = changed;
    await pack.load(async () => indexOf(['aaaaaaaaaaaaaaaa']));
    expect(pack.available).toBe(true);
    expect(changed).toHaveBeenCalledOnce();
    // Not in the pack: seen, never requested.
    expect(pack.lookup('bbbbbbbbbbbbbbbb')).toBeNull();
    expect(pack.summary()).toMatchObject({ entries: 1, seen: 1, replaced: 0, pending: 0 });
  });

  it('asks the server for the selected variant and forgets the old one when it changes', async () => {
    const pack = new TexPack('/texpack/', true, 'a');
    const urls: string[] = [];
    const fetcher = async (url: RequestInfo | URL) => (urls.push(String(url)), indexOf([String(url).includes('/b/') ? 'bbbbbbbbbbbbbbbb' : 'aaaaaaaaaaaaaaaa']));
    await pack.load(fetcher);
    pack.lookup('aaaaaaaaaaaaaaaa');
    await pack.setVariant('b', fetcher);
    expect(urls).toEqual(['/texpack/a/index.json', '/texpack/b/index.json']);
    expect(pack.summary()).toMatchObject({ entries: 1, seen: 0 });
    expect(pack.lookup('aaaaaaaaaaaaaaaa')).toBeNull();
    expect(pack.summary().pending).toBe(0);
  });

  it('does not request anything while switched off', async () => {
    const pack = new TexPack('/texpack/', false);
    const fetcher = vi.fn(async () => indexOf(['aaaaaaaaaaaaaaaa']));
    await pack.load(fetcher);
    expect(pack.lookup('aaaaaaaaaaaaaaaa')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(pack.summary().pending).toBe(0);
  });
});

/** A WebGL2 context that records the texture uploads and the uniform arrays each draw saw. */
function fakeContext() {
  const log = { uploads: [] as unknown[], uniforms: new Map<string, number[]>() };
  const target = {
    createTexture: () => ({}),
    texImage2D: (...args: unknown[]) => { log.uploads.push(args[args.length - 1]); },
    uniform4fv: (loc: { name: string }, v: Float32Array) => { log.uniforms.set(loc.name, Array.from(v)); },
    getUniformLocation: (_: unknown, name: string) => ({ name }),
    getShaderParameter: () => true,
    getProgramParameter: () => true,
  };
  const gl = new Proxy(target, {
    get: (t, key: string) => (key in t ? (t as Record<string, unknown>)[key] : key === 'TEXTURE0' ? 0x84c0 : key.toUpperCase() === key ? 1 : () => ({})),
  });
  return { gl, log };
}

describe('Renderer with a texture pack', () => {
  const rgba = { r: 0, g: 0, b: 0, a: 0 };
  const texels = Uint8Array.from({ length: 32 }, (_, i) => (i % 4 === 3 ? 255 : i));
  const tile = { fmt: 0, siz: 3, line: 0, tmem: 0, palette: 0, cmT: 0, maskT: 1, shiftT: 0, cmS: 0, maskS: 2, shiftS: 0, uls: 8, ult: 4, lrs: 0, lrt: 0, sized: true };
  const state = (): DrawState => ({
    geometryMode: 0, otherModeH: 0, otherModeL: 0, combine: { ...decodeCombine(0, 0), cycles: [{ rgb: [1, 0, 1, 0], alpha: [0, 0, 0, 0] }, { rgb: [0, 0, 0, 0], alpha: [0, 0, 0, 0] }] }, primColor: { ...rgba, minLod: 0, lodFrac: 0 },
    envColor: rgba, fogColor: rgba, blendColor: rgba, fillColor: 0, texture: { on: true, level: 0, tile: 0, scaleS: 0, scaleT: 0 },
    tiles: [tile, tile], textures: [{ id: 5, width: 4, height: 2, rgba: texels, tile: 0 }, null], viewport: { scale: [0, 0, 0], trans: [0, 0, 0] },
    scissor: { mode: 0, xh: 0, yh: 0, xl: 0, yl: 0 }, colorImage: { fmt: 0, siz: 2, width: 320, addr: 0x80100000 }, depthImage: 0,
  });
  const batch = (): TriangleBatch => ({
    kind: 'triangles', state: state(),
    positions: Float32Array.of(-1, -1, 0, 1, 1, -1, 0, 1, 0, 1, 0, 1), colors: new Float32Array(12).fill(1), uvs: new Float32Array(6),
  });
  const draw = (renderer: Renderer) => renderer.drawTask({ batches: [batch()], commands: 0, opcodes: new Map(), unknown: [], problems: [] });
  const make = async (replacement: { width: number; height: number } | null) => {
    const { gl, log } = fakeContext();
    const canvas = { width: 0, height: 0, getContext: () => gl } as unknown as HTMLCanvasElement;
    const pack = new TexPack('/texpack/', true);
    const hash = hashTexture(4, 2, texels);
    await pack.load(async () => indexOf([hash]));
    if (replacement) vi.spyOn(pack, 'lookup').mockReturnValue(replacement as ImageBitmap);
    return { renderer: new Renderer(canvas, 1, undefined, pack), log };
  };

  it('samples a replacement in its own texels: coordinates, tile origin and mask periods double', async () => {
    const { renderer, log } = await make({ width: 8, height: 4 });
    draw(renderer);
    expect(log.uploads.filter(Boolean).at(-1)).toEqual({ width: 8, height: 4 });
    const a = log.uniforms.get('uTexA')!, b = log.uniforms.get('uTexB')!, c = log.uniforms.get('uTexC')!;
    expect(a.slice(0, 4)).toEqual([8, 4, 4, 2]);
    expect(b.slice(0, 2)).toEqual([3, 2]);
    expect(c.slice(0, 2)).toEqual([2, 2]);
  });

  it('takes a replacement four times the size', async () => {
    const { renderer, log } = await make({ width: 16, height: 8 });
    draw(renderer);
    const a = log.uniforms.get('uTexA')!, b = log.uniforms.get('uTexB')!, c = log.uniforms.get('uTexC')!;
    expect(a.slice(0, 4)).toEqual([16, 8, 8, 4]);
    expect(b.slice(0, 2)).toEqual([4, 3]);
    expect(c.slice(0, 2)).toEqual([4, 4]);
  });

  it('draws the original when the replacement is not twice the size', async () => {
    const { renderer, log } = await make({ width: 8, height: 8 });
    draw(renderer);
    expect(log.uploads.filter(Boolean).at(-1)).toBe(texels);
    expect(log.uniforms.get('uTexA')!.slice(0, 4)).toEqual([4, 2, 2, 1]);
    expect(log.uniforms.get('uTexB')!.slice(0, 2)).toEqual([2, 1]);
  });
});
