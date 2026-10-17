// Display-list interpreter: walks a graphics task's command list over a RAM image and writes draw batches into
// buffers in the module's memory, in a form no renderer is assumed for. The commands, their evidence and the formats
// are those of docs/re/display-lists.md. Vertices are transformed to clip space, lit, clipped and grouped by the
// render state they were drawn with; textures are decoded to RGBA8.
//
// The result of a run stays valid until the next run or gfx_reset. Pointers are addresses in the module's memory;
// every array is little-endian host data, so JS wraps it in a typed array without copying. Memory growth moves the
// module's buffer, so views are made after the run.
#ifndef GFX_H
#define GFX_H

#include <stddef.h>
#include <stdint.h>

// ---- Records of the result ------------------------------------------------------------------------------------

typedef struct {
  int32_t fmt, siz;
  // Row length in 64-bit TMEM words.
  int32_t line;
  // TMEM address in 64-bit words.
  int32_t tmem;
  int32_t palette, cm_t, mask_t, shift_t, cm_s, mask_s, shift_s;
  // Tile bounds in 10.2 fixed point texels.
  int32_t uls, ult, lrs, lrt;
  // 1 once SetTileSize has been executed for the tile.
  int32_t sized;
} GfxTile;

// The render state a batch was drawn with. Words are int32 except where marked u32.
typedef struct {
  uint32_t geometry_mode, other_h, other_l;
  // The selector fields of the combiner are decoded from these two words (w0 & 0xffffff, w1) by the reader.
  uint32_t combine_raw[2];
  // r, g, b, a, minLod, lodFrac.
  int32_t prim_color[6];
  int32_t env_color[4], fog_color[4], blend_color[4];
  uint32_t fill_color;
  int32_t texture_on, texture_level, texture_tile;
  uint32_t texture_scale_s, texture_scale_t;
  GfxTile tiles[8];
  // Index into the texture table of the result of the images decoded for the tile the texture command names and the
  // one after it; -1 when nothing is loaded for it. The tile fields are the tile indices they were decoded for.
  int32_t texture_ref[2];
  int32_t texture_ref_tile[2];
  // Scale (x, y, z), then translation (x, y, z), in 10.2 fixed point screen units.
  int32_t viewport[6];
  // mode, xh, yh, xl, yl.
  int32_t scissor[5];
  // fmt, siz, width, addr.
  int32_t color_image[4];
  uint32_t depth_image;
} GfxState;

enum { GFX_BATCH_TRIANGLES = 0, GFX_BATCH_TEXRECT = 1, GFX_BATCH_FILLRECT = 2 };

typedef struct {
  uint32_t kind;
  // Index into the state table.
  uint32_t state;
  // Triangles: the first vertex in the vertex arrays and the number of vertices (three per triangle).
  uint32_t first_vertex, vertex_count;
  // Rectangles: corners in 10.2 fixed point screen units, tile, texture start and per-pixel steps.
  int32_t xl, yl, xh, yh, tile, s, t, dsdx, dtdy;
} GfxBatch;

// A decoded image: `id` is unique for the life of the module (a decode is never given an id twice), the pixels are
// RGBA8, top row first.
typedef struct {
  uint32_t id, width, height;
  const uint8_t *rgba;
} GfxTextureRef;

typedef struct {
  uint32_t addr, w0, w1;
} GfxUnknown;

enum { GFX_PROBLEM_BYTES = 160, GFX_MAX_PROBLEMS = 100 };

// What gfx_result returns: sizes and pointers of the arrays of the last run.
typedef struct {
  uint32_t commands;
  uint32_t batch_count;
  const GfxBatch *batches;
  uint32_t state_count;
  const GfxState *states;
  uint32_t texture_count;
  const GfxTextureRef *textures;
  // Vertices of all triangle batches: positions (x, y, z, w), colours (r, g, b, a) and texture coordinates (s, t),
  // float32, 4 + 4 + 2 per vertex in three separate arrays.
  uint32_t vertex_count;
  const float *positions;
  const float *colors;
  const float *uvs;
  uint32_t problem_count;
  // problem_count NUL-terminated strings of GFX_PROBLEM_BYTES each.
  const char *problems;
  uint32_t unknown_count;
  const GfxUnknown *unknown;
  // Pairs (opcode, times executed) in the order the opcodes first ran.
  uint32_t opcode_count;
  const uint32_t *opcodes;
} GfxResult;

// ---- Entry points ---------------------------------------------------------------------------------------------

// Interprets the list at `start` (a segmented address) in `ram`, a big-endian image of `size` bytes indexed by
// physical address, stopping after `max_commands` commands. Returns the number of commands executed.
uint32_t gfx_run_ram(const uint8_t *ram, uint32_t size, uint32_t start, uint32_t max_commands);
const GfxResult *gfx_result(void);
// Frees the caches and the result buffers.
void gfx_reset(void);
uint32_t gfx_layout(uint32_t what);

// ---- Texture decoding (decode.c) ------------------------------------------------------------------------------

enum { GFX_FMT_RGBA = 0, GFX_FMT_YUV = 1, GFX_FMT_CI = 2, GFX_FMT_IA = 3, GFX_FMT_I = 4 };
enum { GFX_SIZ_4 = 0, GFX_SIZ_8 = 1, GFX_SIZ_16 = 2, GFX_SIZ_32 = 3 };

typedef struct {
  int32_t fmt, siz, width, height;
  // Bytes between the starts of two rows in `data`.
  int32_t row_bytes;
  // Texel data as the game stores it (big-endian); bytes past `data_len` read as zero.
  const uint8_t *data;
  size_t data_len;
  // Offset in `data` of the first texel of the first row.
  size_t offset;
  // For colour-indexed textures: the palette's 16-bit entries (big-endian) and whether they are IA16 (else RGBA16).
  const uint8_t *palette;
  size_t palette_len, palette_offset;
  int32_t palette_ia;
} GfxTextureSource;

// Decodes to width * height RGBA8 texels in `out`.
void gfx_decode_texture(const GfxTextureSource *src, uint8_t *out);

#endif
