// The name of a decoded texture: a 64-bit hash of its size and its RGBA texels, after the interpreter has applied the tile's format and palette.
// The renderer and the tools share it, so a pack file `<hash>.png` is found by whoever decoded the same pixels.

/**
 * The key of a texture by its lower half alone (the rows from `height - height / 2` down), for textures whose upper rows were never loaded and show stale
 * texture memory: the full hash then changes with whatever was there, this one does not.
 */
export function hashLowerHalf(width: number, height: number, rgba: Uint8Array): string {
  const half = height >> 1;
  return hashTexture(width, half, rgba.subarray((height - half) * width * 4));
}

/** Sixteen hex digits from two independent 32-bit lanes (FNV-1a and a multiply-xorshift mix) over the size and the texels. */
export function hashTexture(width: number, height: number, rgba: Uint8Array): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  const mix = (word: number): void => {
    a = Math.imul(a ^ word, 0x01000193);
    b = Math.imul(b ^ (b >>> 15) ^ word, 0x85ebca6b);
    b ^= b >>> 13;
  };
  mix(width);
  mix(height);
  const length = width * height * 4;
  const words = length >>> 2;
  const view = new DataView(rgba.buffer, rgba.byteOffset, length);
  for (let i = 0; i < words; i++) mix(view.getUint32(i * 4, true));
  a = Math.imul(a ^ (a >>> 16), 0x45d9f3b);
  b = Math.imul(b ^ (b >>> 16), 0x45d9f3b);
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
