// Which of the two textures a draw state carries its combiner reads. The interpreter decodes the texture command's tile and the next one for every
// state, but a draw that never reads the second leaves it with whatever its tile descriptor and texture memory happen to hold (a descriptor set up for an
// earlier draw, rows a palette load has since overwritten): such an image is not a texture of the game and has no place in a pack.
import type { DrawState } from '../gfx/types.ts';
import { CycleType, cycleTypeOf } from '../../web/shader.ts';

/** Whether the selector `code` of slot `slot` (0 A, 1 B, 2 C, 3 D) of the colour (`alpha` false) or alpha equation names TEXEL0 and TEXEL1 (web/shader.ts `rgbInput`, `alphaInput`). */
function reads(slot: number, code: number, alpha: boolean): [boolean, boolean] {
  if (code === 1) return [true, false];
  if (code === 2) return [false, true];
  if (!alpha && slot === 2) return [code === 8, code === 9];
  return [false, false];
}

/** For each of `state.textures`: whether the draw's combiner reads that texel (the first from tile 0 of the texture command, the second from the next tile). */
export function texturesRead(state: DrawState): [boolean, boolean] {
  const type = cycleTypeOf(state.otherModeH);
  if (type === CycleType.FILL) return [false, false];
  if (type === CycleType.COPY) return [true, false];
  const used: [boolean, boolean] = [false, false];
  const cycles = type === CycleType.TWO ? 2 : 1;
  for (let n = 0; n < cycles; n++) {
    const stage = state.combine.cycles[n]!;
    // In the second cycle the combiner's TEXEL0 is the draw's second lookup and its TEXEL1 the first.
    for (const [codes, alpha] of [[stage.rgb, false], [stage.alpha, true]] as const) {
      codes.forEach((code, slot) => {
        const [t0, t1] = reads(slot, code, alpha);
        if (t0) used[n === 0 ? 0 : 1] = true;
        if (t1) used[n === 0 ? 1 : 0] = true;
      });
    }
  }
  return used;
}
