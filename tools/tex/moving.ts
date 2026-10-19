// Reads the texture log the page records while the game is walked (`ootTexPack.recorded()` in web/renderer.ts) into the counts that say whether a pack
// answers for every texture it has: per graphics task the textures drawn, each as `<hash><state>`, state `+` replaced, `~` in the pack but not loaded
// yet, `-` not in the pack.
import type { TextureRecord } from './collect.ts';
import { skipReason } from './upscale.ts';

export interface TextureFacts {
  width: number;
  height: number;
  fmt: number;
  siz: number;
  unloaded: number;
  /** The picture as base64 RGBA8, kept for textures the pack has no entry for. */
  rgba?: string;
}

export interface MovingReport {
  tasks: number;
  textures: number;
  /** Textures the pack has an entry for, and how many of them were drawn original in a task after being drawn replaced (flicker). */
  inPack: number;
  flickering: string[];
  /** Task-draws of textures in the pack that were still original because the replacement had not arrived. */
  pendingDraws: number;
  /** Textures drawn with no entry in the pack, each with the reason. */
  unresolved: { hash: string; tasks: number; reason: string }[];
}

export function analyzeMoving(frames: string[][], facts: Record<string, TextureFacts>, dump: Map<string, TextureRecord>): MovingReport {
  const state = new Map<string, { replaced: boolean; flicker: boolean; none: number; draws: number }>();
  let pendingDraws = 0;
  for (const frame of frames) {
    for (const entry of frame) {
      const hash = entry.slice(0, 16), s = entry[16]!;
      let t = state.get(hash);
      if (!t) state.set(hash, (t = { replaced: false, flicker: false, none: 0, draws: 0 }));
      t.draws++;
      if (s === '+') t.replaced = true;
      else if (t.replaced) t.flicker = true;
      if (s === '~') pendingDraws++;
      if (s === '-') t.none++;
    }
  }
  const unresolved = [...state]
    .filter(([, t]) => t.none > 0)
    .map(([hash, t]) => {
      const record = dump.get(hash);
      const f = facts[hash];
      const reason = record
        ? `in the dump, left original: ${skipReason(record) ?? 'it has a replacement in the dump but the pack does not list it'}`
        : `not in the dump (${f?.width}x${f?.height}, format ${f?.fmt}.${f?.siz}, ${f?.unloaded ?? 0} texels not loaded)`;
      return { hash, tasks: t.none, reason };
    });
  return {
    tasks: frames.length,
    textures: state.size,
    inPack: [...state.values()].filter((t) => t.draws > t.none).length,
    flickering: [...state].filter(([, t]) => t.flicker).map(([hash]) => hash),
    pendingDraws,
    unresolved,
  };
}
