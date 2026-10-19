// The name of a decoded texture: a 64-bit hash of its format, size and the texels the game loaded for it. The renderer and the tools share it, so a
// pack file `<hash>.png` is found by whoever decoded the same pixels.
//
// Tiles can be larger than the block the game loads into them (runtime/gfx/dl.c, "Loaded texels"); the texels outside the block are left over from
// earlier loads and change from use to use. The interpreter reports which texels the current loads wrote, and only those are hashed. The palette
// of a colour-indexed texture is part of the key through the texels, which are decoded through it.

/** What the key is made of: a decoded texture as the interpreter reports it (`DecodedTexture` of tools/gfx/types.ts). */
export interface HashableTexture {
  width: number;
  height: number;
  rgba: Uint8Array;
  /** One byte per texel, 1 where the loads wrote it; null or absent when all texels were written. */
  loaded?: Uint8Array | null;
  /** Texel format and size of the tile the image was decoded for. */
  fmt?: number;
  siz?: number;
}

/** Stands for a texel that was not loaded, so that its leftover value does not enter the key but its place does. */
const NOT_LOADED = 0x6c6f6164;

export function hashImage(image: HashableTexture): string {
  return hashTexture(image.width, image.height, image.rgba, image.loaded, image.fmt, image.siz);
}

/** Sixteen hex digits from two independent 32-bit lanes (FNV-1a and a multiply-xorshift mix) over the format, size and loaded texels. */
export function hashTexture(width: number, height: number, rgba: Uint8Array, loaded?: Uint8Array | null, fmt = 0, siz = 0): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  const mix = (word: number): void => {
    a = Math.imul(a ^ word, 0x01000193);
    b = Math.imul(b ^ (b >>> 15) ^ word, 0x85ebca6b);
    b ^= b >>> 13;
  };
  mix(width);
  mix(height);
  mix((fmt << 2) | siz);
  const texels = width * height;
  const view = new DataView(rgba.buffer, rgba.byteOffset, texels * 4);
  for (let i = 0; i < texels; i++) mix(loaded && loaded[i] === 0 ? NOT_LOADED : view.getUint32(i * 4, true));
  a = Math.imul(a ^ (a >>> 16), 0x45d9f3b);
  b = Math.imul(b ^ (b >>> 16), 0x45d9f3b);
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
