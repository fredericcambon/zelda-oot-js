// Content checks that back a classification: does a file decode as the image the loader's context suggests, is it text.

import { decodeTexture, Fmt, Siz } from '../gfx/decode.ts';

/** Fraction of horizontally neighbouring texels of an image that are within `tolerance` per channel of each other. */
export function smoothness(rgba: Uint8Array, width: number, height: number, tolerance = 24): number {
  let near = 0, total = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x + 1 < width; x++) {
      const a = (y * width + x) * 4, b = a + 4;
      let ok = true;
      for (let c = 0; c < 4 && ok; c++) ok = Math.abs(rgba[a + c]! - rgba[b + c]!) <= tolerance;
      if (ok) near++;
      total++;
    }
  }
  return total === 0 ? 0 : near / total;
}

/** Random bytes score about 0.02 under `smoothness`; pictures and text-on-flat-background images score well above 0.5. */
export const IMAGE_SMOOTHNESS = 0.5;

export function iaSmoothness(data: Uint8Array, width: number, height: number): number {
  const img = decodeTexture({ fmt: Fmt.IA, siz: Siz.B8, width, height, rowBytes: width, data });
  return smoothness(img.rgba, width, height);
}

/** CI8 image of `width` x `height` at `offset`, coloured by the 256 RGBA16 entries at `paletteOffset` of `palette`. */
export function ci8Smoothness(data: Uint8Array, offset: number, width: number, height: number, palette: Uint8Array, paletteOffset: number): number {
  const img = decodeTexture({ fmt: Fmt.CI, siz: Siz.B8, width, height, rowBytes: width, data, offset, palette: { data: palette, offset: paletteOffset, ia: false } });
  return smoothness(img.rgba, width, height);
}

/** Fraction of bytes that are printable ASCII. */
export function printableRatio(data: Uint8Array): number {
  let n = 0;
  for (const b of data) if (b >= 0x20 && b < 0x7f) n++;
  return data.length === 0 ? 0 : n / data.length;
}
