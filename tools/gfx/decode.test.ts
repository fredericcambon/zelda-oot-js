import { describe, expect, it } from 'vitest';
import { decodeTexture, Fmt, Siz } from './decode.ts';

const px = (img: { rgba: Uint8Array }, i: number) => Array.from(img.rgba.subarray(i * 4, i * 4 + 4));
const bytes = (...b: number[]) => Uint8Array.from(b);

describe('texture decoders', () => {
  it('RGBA16 expands 5-bit channels and the 1-bit alpha', () => {
    const img = decodeTexture({ fmt: Fmt.RGBA, siz: Siz.B16, width: 2, height: 1, rowBytes: 4, data: bytes(0xf8, 0x01, 0x00, 0x3e) });
    expect(px(img, 0)).toEqual([255, 0, 0, 255]);
    expect(px(img, 1)).toEqual([0, 0, 255, 0]);
  });

  it('RGBA32 copies the four bytes', () => {
    const img = decodeTexture({ fmt: Fmt.RGBA, siz: Siz.B32, width: 1, height: 1, rowBytes: 4, data: bytes(1, 2, 3, 4) });
    expect(px(img, 0)).toEqual([1, 2, 3, 4]);
  });

  it('IA16, IA8 and IA4 split intensity and alpha', () => {
    expect(px(decodeTexture({ fmt: Fmt.IA, siz: Siz.B16, width: 1, height: 1, rowBytes: 2, data: bytes(0x80, 0x40) }), 0)).toEqual([0x80, 0x80, 0x80, 0x40]);
    expect(px(decodeTexture({ fmt: Fmt.IA, siz: Siz.B8, width: 1, height: 1, rowBytes: 1, data: bytes(0xf3) }), 0)).toEqual([255, 255, 255, 51]);
    const ia4 = decodeTexture({ fmt: Fmt.IA, siz: Siz.B4, width: 2, height: 1, rowBytes: 1, data: bytes(0xf6) });
    expect(px(ia4, 0)).toEqual([255, 255, 255, 255]);
    expect(px(ia4, 1)).toEqual([109, 109, 109, 0]);
  });

  it('I8 and I4 replicate the intensity into alpha', () => {
    expect(px(decodeTexture({ fmt: Fmt.I, siz: Siz.B8, width: 1, height: 1, rowBytes: 1, data: bytes(0x7f) }), 0)).toEqual([0x7f, 0x7f, 0x7f, 0x7f]);
    const i4 = decodeTexture({ fmt: Fmt.I, siz: Siz.B4, width: 2, height: 1, rowBytes: 1, data: bytes(0x3f) });
    expect(px(i4, 0)).toEqual([51, 51, 51, 51]);
    expect(px(i4, 1)).toEqual([255, 255, 255, 255]);
  });

  it('CI4 and CI8 look the index up in the palette, as RGBA16 or IA16', () => {
    const palette = bytes(0, 0, 0xf8, 0x01, 0x12, 0x34);
    const ci8 = decodeTexture({ fmt: Fmt.CI, siz: Siz.B8, width: 3, height: 1, rowBytes: 3, data: bytes(1, 2, 0), palette: { data: palette, offset: 0, ia: false } });
    expect(px(ci8, 0)).toEqual([255, 0, 0, 255]);
    expect(px(ci8, 2)).toEqual([0, 0, 0, 0]);
    const ci4 = decodeTexture({ fmt: Fmt.CI, siz: Siz.B4, width: 2, height: 1, rowBytes: 1, data: bytes(0x12), palette: { data: palette, offset: 0, ia: true } });
    expect(px(ci4, 0)).toEqual([0xf8, 0xf8, 0xf8, 1]);
    expect(px(ci4, 1)).toEqual([0x12, 0x12, 0x12, 0x34]);
  });

  it('honours the row stride and the first-texel offset', () => {
    const img = decodeTexture({ fmt: Fmt.I, siz: Siz.B8, width: 2, height: 2, rowBytes: 4, offset: 1, data: bytes(9, 1, 2, 9, 9, 3, 4, 9) });
    expect(Array.from(img.rgba).filter((_, i) => i % 4 === 0)).toEqual([1, 2, 3, 4]);
  });
});
