// Textures that are soft gradients (the sky's cloud layers): almost no neighbouring texels differ by more than a step or two of the console's 5-bit colour.
import type { DecodedTexture } from '../tools/gfx/types.ts';

/** Largest difference, in any channel, between two adjacent texels that still counts as a gradient step (two 5-bit steps are 16 of 255). */
export const MAX_STEP = 16;
/** Share of adjacent texel pairs allowed to differ by more than `MAX_STEP`. */
export const MAX_EDGE_SHARE = 0.05;

const verdicts = new Map<number, boolean>();
const MAX_VERDICTS = 4096;

/**
 * Whether at most `MAX_EDGE_SHARE` of the horizontally and vertically adjacent texel pairs of the image differ by more than `MAX_STEP`. The
 * console's 3-point filter and four-texel bilinear differ by less than the step across a gradient, and the only visible difference is that
 * the 3-point filter cuts every one-step contour of the gradient along a diagonal. Measured on the title sky's textures: 0.3 to 2.7 % of pairs
 * (the cloud edges); the textures of the logo, the horse and the HUD: 28 to 78 %.
 */
export function isLowContrast(image: DecodedTexture): boolean {
  let verdict = verdicts.get(image.id);
  if (verdict === undefined) {
    if (verdicts.size >= MAX_VERDICTS) verdicts.clear();
    verdicts.set(image.id, (verdict = scan(image)));
  }
  return verdict;
}

function scan({ width, height, rgba }: DecodedTexture): boolean {
  const stride = width * 4;
  const limit = MAX_EDGE_SHARE * (2 * width * height - width - height);
  let edges = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = y * stride + x * 4;
      let right = false, down = false;
      for (let c = 0; c < 4; c++) {
        const v = rgba[o + c]!;
        if (x + 1 < width && Math.abs(v - rgba[o + 4 + c]!) > MAX_STEP) right = true;
        if (y + 1 < height && Math.abs(v - rgba[o + stride + c]!) > MAX_STEP) down = true;
      }
      edges += +right + +down;
      if (edges > limit) return false;
    }
  }
  return true;
}

/**
 * The texels of the image smoothed by a [1 2 1] kernel along both axes (edges repeat their outermost texel). The sky's tiles carry noise that
 * changes by a step from one texel to the next; bilinear turns it into a lattice of dots at the texel spacing, and the blur takes it out.
 */
export function softened({ width, height, rgba }: DecodedTexture): Uint8Array {
  const pass = (src: Uint8Array, dx: number, dy: number): Uint8Array => {
    const out = new Uint8Array(src.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const a = (Math.max(0, y - dy) * width + Math.max(0, x - dx)) * 4;
        const b = (y * width + x) * 4;
        const c = (Math.min(height - 1, y + dy) * width + Math.min(width - 1, x + dx)) * 4;
        for (let k = 0; k < 4; k++) out[b + k] = (src[a + k]! + 2 * src[b + k]! + src[c + k]! + 2) >> 2;
      }
    }
    return out;
  };
  return pass(pass(rgba, 1, 0), 0, 1);
}
