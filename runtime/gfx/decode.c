// Texture decoders: the RDP texel formats to RGBA8 (4 bytes per texel, row-major, top row first).
#include <string.h>
#include "gfx.h"

static inline unsigned expand5(unsigned v) { return (v << 3) | (v >> 2); }
static inline unsigned expand4(unsigned v) { return v * 17; }
static inline unsigned expand3(unsigned v) { return (v << 5) | (v << 2) | (v >> 1); }

static inline void put(uint8_t *out, unsigned r, unsigned g, unsigned b, unsigned a) {
  out[0] = (uint8_t)r;
  out[1] = (uint8_t)g;
  out[2] = (uint8_t)b;
  out[3] = (uint8_t)a;
}

static inline void rgba16(uint8_t *out, unsigned v) {
  put(out, expand5((v >> 11) & 31), expand5((v >> 6) & 31), expand5((v >> 1) & 31), v & 1 ? 255 : 0);
}

static inline void ia16(uint8_t *out, unsigned v) {
  unsigned i = v >> 8;
  put(out, i, i, i, v & 255);
}

// The RGBA8 value of each palette index (16 or 256 entries; entries past the end of the palette data read as 0).
static void palette_table(const GfxTextureSource *s, uint8_t *table, unsigned entries) {
  for (unsigned i = 0; i < entries; i++) {
    size_t p = s->palette_offset + (size_t)i * 2;
    unsigned v = p + 1 < s->palette_len ? ((unsigned)s->palette[p] << 8) | s->palette[p + 1] : 0;
    if (s->palette_ia) ia16(table + i * 4, v);
    else rgba16(table + i * 4, v);
  }
}

void gfx_decode_texture(const GfxTextureSource *s, uint8_t *out) {
  const int ci = s->fmt == GFX_FMT_CI;
  uint8_t table[256 * 4];
  if (ci) {
    memset(table, 0, sizeof table);
    palette_table(s, table, s->siz == GFX_SIZ_4 ? 16 : 256);
  }
  const uint8_t *data = s->data;
  const size_t len = s->data_len;
#define AT(i) ((size_t)(i) < len ? data[(size_t)(i)] : 0u)
  for (int y = 0; y < s->height; y++) {
    const size_t row = s->offset + (size_t)y * (size_t)s->row_bytes;
    uint8_t *px = out + (size_t)y * (size_t)s->width * 4;
    switch (s->siz) {
      case GFX_SIZ_4:
        for (int x = 0; x < s->width; x++, px += 4) {
          unsigned b = AT(row + (x >> 1));
          unsigned n = x & 1 ? b & 15 : b >> 4;
          if (ci) put(px, table[n * 4], table[n * 4 + 1], table[n * 4 + 2], table[n * 4 + 3]);
          else if (s->fmt == GFX_FMT_IA) {
            unsigned i = expand3(n >> 1);
            put(px, i, i, i, n & 1 ? 255 : 0);
          } else {
            unsigned i = expand4(n);
            put(px, i, i, i, i);
          }
        }
        break;
      case GFX_SIZ_8:
        for (int x = 0; x < s->width; x++, px += 4) {
          unsigned b = AT(row + x);
          if (ci) put(px, table[b * 4], table[b * 4 + 1], table[b * 4 + 2], table[b * 4 + 3]);
          else if (s->fmt == GFX_FMT_IA) {
            unsigned i = expand4(b >> 4);
            put(px, i, i, i, expand4(b & 15));
          } else put(px, b, b, b, b);
        }
        break;
      case GFX_SIZ_16:
        for (int x = 0; x < s->width; x++, px += 4) {
          unsigned v = (AT(row + (size_t)x * 2) << 8) | AT(row + (size_t)x * 2 + 1);
          if (s->fmt == GFX_FMT_IA) ia16(px, v);
          else rgba16(px, v);
        }
        break;
      default:
        for (int x = 0; x < s->width; x++, px += 4) {
          put(px, AT(row + (size_t)x * 4), AT(row + (size_t)x * 4 + 1), AT(row + (size_t)x * 4 + 2), AT(row + (size_t)x * 4 + 3));
        }
    }
  }
#undef AT
}
