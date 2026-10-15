// Texture decoders: the RDP texel formats to RGBA8 (4 bytes per texel, row-major, top row first).

/** Texel formats of the RDP (the `fmt` field of SetTextureImage and SetTile). */
export const Fmt = { RGBA: 0, YUV: 1, CI: 2, IA: 3, I: 4 } as const;

/** Bits per texel (the `siz` field): 4, 8, 16 or 32. */
export const Siz = { B4: 0, B8: 1, B16: 2, B32: 3 } as const;

export interface TextureSource {
  fmt: number;
  siz: number;
  width: number;
  height: number;
  /** Bytes between the starts of two rows in `data`. */
  rowBytes: number;
  /** Texel data as the game stores it (big-endian). */
  data: Uint8Array;
  /** Offset in `data` of the first texel of the first row. */
  offset?: number;
  /** For CI textures: the palette's 16-bit entries (big-endian) and whether they are IA16 (else RGBA16). */
  palette?: { data: Uint8Array; offset: number; ia: boolean };
}

export interface RgbaImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

export const bitsPerTexel = (siz: number): number => 4 << siz;

const expand5 = (v: number) => (v << 3) | (v >> 2);
const expand4 = (v: number) => v * 17;
const expand3 = (v: number) => (v << 5) | (v << 2) | (v >> 1);

function put(out: Uint8Array, at: number, r: number, g: number, b: number, a: number): void {
  out[at] = r;
  out[at + 1] = g;
  out[at + 2] = b;
  out[at + 3] = a;
}

function rgba16(out: Uint8Array, at: number, v: number): void {
  put(out, at, expand5((v >> 11) & 31), expand5((v >> 6) & 31), expand5((v >> 1) & 31), v & 1 ? 255 : 0);
}

function ia16(out: Uint8Array, at: number, v: number): void {
  const i = v >> 8;
  put(out, at, i, i, i, v & 255);
}

export function decodeTexture(src: TextureSource): RgbaImage {
  const { width, height, rowBytes, data } = src;
  const base = src.offset ?? 0;
  const rgba = new Uint8Array(width * height * 4);
  const pal = src.palette;
  const color = (idx: number, at: number) => {
    const p = pal ? pal.offset + idx * 2 : -1;
    const v = pal && p + 1 < pal.data.length ? (pal.data[p]! << 8) | pal.data[p + 1]! : 0;
    if (pal?.ia) ia16(rgba, at, v);
    else rgba16(rgba, at, v);
  };
  for (let y = 0; y < height; y++) {
    const row = base + y * rowBytes;
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      const byte = (i: number) => data[i] ?? 0;
      switch (src.siz) {
        case Siz.B4: {
          const b = byte(row + (x >> 1));
          const n = x & 1 ? b & 15 : b >> 4;
          if (src.fmt === Fmt.CI) color(n, at);
          else if (src.fmt === Fmt.IA) {
            const i = expand3(n >> 1);
            put(rgba, at, i, i, i, n & 1 ? 255 : 0);
          } else {
            const i = expand4(n);
            put(rgba, at, i, i, i, i);
          }
          break;
        }
        case Siz.B8: {
          const b = byte(row + x);
          if (src.fmt === Fmt.CI) color(b, at);
          else if (src.fmt === Fmt.IA) {
            const i = expand4(b >> 4);
            put(rgba, at, i, i, i, expand4(b & 15));
          } else put(rgba, at, b, b, b, b);
          break;
        }
        case Siz.B16: {
          const v = (byte(row + x * 2) << 8) | byte(row + x * 2 + 1);
          if (src.fmt === Fmt.IA) ia16(rgba, at, v);
          else rgba16(rgba, at, v);
          break;
        }
        default:
          put(rgba, at, byte(row + x * 4), byte(row + x * 4 + 1), byte(row + x * 4 + 2), byte(row + x * 4 + 3));
      }
    }
  }
  return { width, height, rgba };
}
