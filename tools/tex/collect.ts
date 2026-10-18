// Collects the unique decoded textures of the display lists a run draws, with what is needed to upscale them (how the tiles that sample them
// wrap, what their alpha holds) and to tell those whose pixels change from frame to frame.
import type { DisplayListResult, DrawState, TileState } from '../gfx/types.ts';
import { shiftScale } from '../../web/shader.ts';
import { partialFamilies } from './families.ts';
import { hashTexture } from './hash.ts';

export type Edge = 'wrap' | 'mirror' | 'clamp';
export type AlphaKind = 'opaque' | 'binary' | 'blend';

export interface TextureRecord {
  hash: string;
  width: number;
  height: number;
  /** Tile format (`Fmt`) and texel size of the tile that sampled it first. */
  fmt: number;
  siz: number;
  /** How the tiles that sampled it treat coordinates outside it, along s and t (`wrap` when any tile repeated it). */
  edgeS: Edge;
  edgeT: Edge;
  alpha: AlphaKind;
  /** Red, green and blue are equal in every texel that is not transparent. */
  gray: boolean;
  /** Frames (graphics tasks) it was drawn in, and the first and last of them. */
  frames: number;
  first: number;
  last: number;
  scenes: number[];
  /** The tile descriptor of the first use, and the texel extent (s0, t0, s1, t1, relative to the tile's origin) the triangles drawn with it reached. */
  tile: TileState;
  reach: [number, number, number, number] | null;
  /** Key (`hashLowerHalf`) shared with the textures that differ from this one only in their upper half, or null (see families.ts). */
  family: string | null;
  /** Short-lived pixels of a group that keeps producing new ones (see `TextureCollector.finish`): a texture the game rewrites. */
  volatile: boolean;
}

/** Edge treatment of a tile along one axis: a mask repeats (wrap or mirror), otherwise coordinates are clamped to the tile. */
export function edgeOf(mask: number, cm: number): Edge {
  if (mask === 0 || (cm & 2) !== 0) return 'clamp';
  return (cm & 1) !== 0 ? 'mirror' : 'wrap';
}

export function alphaKindOf(rgba: Uint8Array): AlphaKind {
  let zero = 0, full = 0;
  const n = rgba.length >> 2;
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3]!;
    if (a === 0) zero++;
    else if (a === 255) full++;
  }
  if (full === n) return 'opaque';
  return zero + full === n ? 'binary' : 'blend';
}

export function isGray(rgba: Uint8Array): boolean {
  for (let i = 0; i < rgba.length; i += 4) if (rgba[i + 3] !== 0 && (rgba[i] !== rgba[i + 1] || rgba[i] !== rgba[i + 2])) return false;
  return true;
}

interface Entry extends TextureRecord {
  rgba: Uint8Array;
  wrapS: boolean;
  wrapT: boolean;
  mirrorS: boolean;
  mirrorT: boolean;
  /** The frame it was last counted in, so that each frame counts once. */
  seenIn: number;
}

interface Group {
  present: number;
  withNew: number;
  newThisFrame: boolean;
  presentThisFrame: boolean;
}

/** A group (a size and a texel format) churns when it is drawn in at least this many frames and has new pixels in at least this share of them. */
export const GROUP_MIN_FRAMES = 20;
export const GROUP_NEW_SHARE = 0.5;
/** In a churning group, pixels seen in at most this many frames belong to a texture that changes. */
export const SHORT_LIVED_FRAMES = 5;

export class TextureCollector {
  private readonly entries = new Map<string, Entry>();
  private readonly hashOfId = new Map<number, string>();
  private readonly groups = new Map<string, Group>();
  private readonly groupOf = new Map<string, string>();
  private frame = 0;
  private scene = -1;

  /** Starts the next frame (graphics task). */
  nextFrame(scene: number): void {
    this.finishFrame();
    this.frame++;
    this.scene = scene;
  }

  private finishFrame(): void {
    for (const g of this.groups.values()) {
      if (g.presentThisFrame) {
        g.present++;
        if (g.newThisFrame) g.withNew++;
      }
      g.presentThisFrame = g.newThisFrame = false;
    }
  }

  /** Widens the reach of each texture of the triangle batches by the texel coordinates their vertices ask for. */
  private reach(result: DisplayListResult): void {
    for (const b of result.batches) {
      if (b.kind !== 'triangles') continue;
      for (const image of b.state.textures) {
        const e = image && this.entries.get(this.hashOfId.get(image.id) ?? '');
        if (!e) continue;
        const tile = b.state.tiles[image!.tile]!;
        const ks = shiftScale(tile.shiftS), kt = shiftScale(tile.shiftT);
        for (let i = 0; i < b.uvs.length; i += 2) {
          const s = b.uvs[i]! * ks - tile.uls / 4, t = b.uvs[i + 1]! * kt - tile.ult / 4;
          const r = (e.reach ??= [s, t, s, t]);
          r[0] = Math.min(r[0], s); r[1] = Math.min(r[1], t); r[2] = Math.max(r[2], s); r[3] = Math.max(r[3], t);
        }
      }
    }
  }

  add(result: DisplayListResult): void {
    const states = new Set<DrawState>();
    for (const b of result.batches) states.add(b.state);
    for (const state of states) {
      for (const image of state.textures) {
        if (!image) continue;
        const tile = state.tiles[image.tile]!;
        let hash = this.hashOfId.get(image.id);
        if (hash === undefined) {
          hash = hashTexture(image.width, image.height, image.rgba);
          this.hashOfId.set(image.id, hash);
        }
        const group = `${image.width}x${image.height}:${tile.fmt}.${tile.siz}`;
        let g = this.groups.get(group);
        if (!g) this.groups.set(group, (g = { present: 0, withNew: 0, newThisFrame: false, presentThisFrame: false }));
        g.presentThisFrame = true;
        let e = this.entries.get(hash);
        if (!e) {
          e = {
            hash, width: image.width, height: image.height, fmt: tile.fmt, siz: tile.siz, edgeS: 'clamp', edgeT: 'clamp',
            alpha: alphaKindOf(image.rgba), gray: isGray(image.rgba), frames: 0, first: this.frame, last: this.frame, scenes: [], tile: { ...tile }, reach: null, family: null, volatile: false,
            rgba: image.rgba.slice(), wrapS: false, wrapT: false, mirrorS: false, mirrorT: false, seenIn: 0,
          };
          this.entries.set(hash, e);
          this.groupOf.set(hash, group);
          g.newThisFrame = true;
        }
        const s = edgeOf(tile.maskS, tile.cmS), t = edgeOf(tile.maskT, tile.cmT);
        e.wrapS ||= s === 'wrap';
        e.wrapT ||= t === 'wrap';
        e.mirrorS ||= s === 'mirror';
        e.mirrorT ||= t === 'mirror';
        if (e.seenIn !== this.frame) {
          e.seenIn = this.frame;
          e.frames++;
          e.last = this.frame;
        }
        if (this.scene >= 0 && !e.scenes.includes(this.scene)) e.scenes.push(this.scene);
      }
    }
    this.reach(result);
  }

  /** The textures with their final classification, their pixels by hash, and the groups that churn. */
  finish(): { records: TextureRecord[]; pixels: Map<string, Uint8Array>; churningGroups: { group: string; present: number; withNew: number }[] } {
    this.finishFrame();
    const churning = new Set<string>();
    const churningGroups: { group: string; present: number; withNew: number }[] = [];
    for (const [group, g] of this.groups) {
      if (g.present >= GROUP_MIN_FRAMES && g.withNew / g.present >= GROUP_NEW_SHARE) {
        churning.add(group);
        churningGroups.push({ group, present: g.present, withNew: g.withNew });
      }
    }
    const records: TextureRecord[] = [];
    const pixels = new Map<string, Uint8Array>();
    for (const [hash, e] of this.entries) {
      const record: TextureRecord = {
        hash, width: e.width, height: e.height, fmt: e.fmt, siz: e.siz,
        edgeS: e.wrapS ? 'wrap' : e.mirrorS ? 'mirror' : 'clamp', edgeT: e.wrapT ? 'wrap' : e.mirrorT ? 'mirror' : 'clamp',
        alpha: e.alpha, gray: e.gray, frames: e.frames, first: e.first, last: e.last, scenes: e.scenes, tile: e.tile, reach: e.reach, family: null,
        volatile: churning.has(this.groupOf.get(hash)!) && e.frames <= SHORT_LIVED_FRAMES,
      };
      records.push(record);
      pixels.set(hash, e.rgba);
    }
    for (const [key, hashes] of partialFamilies(records.map((r) => ({ hash: r.hash, image: { width: r.width, height: r.height, rgba: pixels.get(r.hash)! } })))) {
      for (const hash of hashes) records.find((r) => r.hash === hash)!.family = key;
    }
    return { records, pixels, churningGroups };
  }
}
