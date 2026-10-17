// Display-list interpreter (see gfx.h). Arithmetic is done in double wherever the notes describe real-valued maths and
// rounded to float32 where a value is stored, so a result is bit-identical on every host; the file is compiled without
// floating-point contraction.
#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "gfx.h"

// ---- Commands ---------------------------------------------------------------------------------------------------

enum {
  OP_VTX = 0x01, OP_MODIFYVTX = 0x02, OP_CULLDL = 0x03, OP_BRANCH_Z = 0x04, OP_TRI1 = 0x05, OP_TRI2 = 0x06, OP_QUAD = 0x07,
  // Opcodes 0x09 and 0x0A belong to the 2D microcode (see OP_LOAD_UCODE), not to the 3D one.
  OP_BG_1CYC = 0x09, OP_BG_COPY = 0x0a,
  OP_TEXTURE = 0xd7, OP_POPMTX = 0xd8, OP_GEOMETRYMODE = 0xd9, OP_MTX = 0xda, OP_MOVEWORD = 0xdb, OP_MOVEMEM = 0xdc,
  OP_LOAD_UCODE = 0xdd, OP_DL = 0xde, OP_ENDDL = 0xdf, OP_RDPHALF_1 = 0xe1, OP_SETOTHERMODE_L = 0xe2, OP_SETOTHERMODE_H = 0xe3,
  OP_TEXRECT = 0xe4, OP_RDPLOADSYNC = 0xe6, OP_RDPPIPESYNC = 0xe7, OP_RDPTILESYNC = 0xe8, OP_RDPFULLSYNC = 0xe9,
  OP_SETSCISSOR = 0xed, OP_SETOTHERMODE = 0xef, OP_LOADTLUT = 0xf0, OP_RDPHALF_2 = 0xf1, OP_SETTILESIZE = 0xf2,
  OP_LOADBLOCK = 0xf3, OP_LOADTILE = 0xf4, OP_SETTILE = 0xf5, OP_FILLRECT = 0xf6, OP_SETFILLCOLOR = 0xf7,
  OP_SETFOGCOLOR = 0xf8, OP_SETBLENDCOLOR = 0xf9, OP_SETPRIMCOLOR = 0xfa, OP_SETENVCOLOR = 0xfb, OP_SETCOMBINE = 0xfc,
  OP_SETTIMG = 0xfd, OP_SETZIMG = 0xfe, OP_SETCIMG = 0xff,
};

// Operation of the MOVEWORD command (byte 1 of the first word) and target of MOVEMEM (byte 3 of the first word).
enum { MW_NUMLIGHT = 0x02, MW_CLIP = 0x04, MW_SEGMENT = 0x06, MW_FOG = 0x08, MW_PERSPNORM = 0x0e };
enum { MM_VIEWPORT = 0x08, MM_LIGHT = 0x0a };

// Bits of the geometry mode.
enum { GEO_LIGHTING = 0x020000, GEO_TEXTURE_GEN = 0x040000, GEO_TEXTURE_GEN_LINEAR = 0x080000, GEO_FOG = 0x010000 };

// Bits of the MTX command's parameter byte (after undoing the inversion of the push bit).
enum { MTX_PROJECTION = 0x04, MTX_LOAD = 0x02, MTX_PUSH = 0x01 };

enum {
  MAX_DL_DEPTH = 32, VERTEX_SLOTS = 32, TMEM_BYTES = 4096, TEXTURE_CACHE_LIMIT = 1024, BG_RECORD_BYTES = 40, BG_CACHE_ENTRIES = 8,
  LIGHT_SLOTS = 10, MICROCODE_DATA_SCAN = 0x400,
};

// Text in the data segment of the 2D microcode, and how far into the segment it is searched for.
static const char S2DEX_SIGNATURE[] = "S2DEX";

// How far outside the screen's edge a vertex may be before the microcode clips the triangle: the planes sit at twice w.
#define GUARD_BAND 2.0

// ---- Number helpers with the semantics of the notes' formulas (JavaScript's Math functions) ---------------------

static double js_max(double a, double b) {
  if (a != a || b != b) return NAN;
  if (a == 0 && b == 0) return signbit(a) ? b : a;
  return a > b ? a : b;
}

static double js_min(double a, double b) {
  if (a != a || b != b) return NAN;
  if (a == 0 && b == 0) return signbit(a) ? a : b;
  return a < b ? a : b;
}

// The integer a double becomes when taken modulo 2^32.
static uint32_t to_u32(double d) {
  if (!isfinite(d)) return 0;
  d = fmod(trunc(d), 4294967296.0);
  if (d < 0) d += 4294967296.0;
  return (uint32_t)d;
}

// Text of a number as the problem messages show it: whole, or with the one decimal that halving an odd value leaves.
static void format_number(char *out, size_t size, double d) {
  if (d == floor(d)) snprintf(out, size, "%.0f", d);
  else snprintf(out, size, "%.1f", d);
}

// ---- Growable arrays ----------------------------------------------------------------------------------------------

static void *grow(void *p, size_t *cap, size_t need, size_t elt) {
  if (need <= *cap) return p;
  size_t c = *cap ? *cap : 64;
  while (c < need) c *= 2;
  void *q = realloc(p, c * elt);
  if (!q) abort();
  *cap = c;
  return q;
}

#define VEC(type) struct { type *v; size_t n, cap; }
#define VEC_PUSH(vec, item) do { (vec).v = grow((vec).v, &(vec).cap, (vec).n + 1, sizeof *(vec).v); (vec).v[(vec).n++] = (item); } while (0)
#define VEC_FREE(vec) do { free((vec).v); (vec).v = NULL; (vec).n = (vec).cap = 0; } while (0)

// ---- Result buffers -----------------------------------------------------------------------------------------------

static VEC(float) out_pos, out_col, out_uv;
static VEC(GfxBatch) out_batches;
static VEC(GfxState) out_states;
static VEC(GfxTextureRef) out_textures;
static VEC(GfxUnknown) out_unknown;
static VEC(uint32_t) out_opcodes;
static char out_problems[GFX_MAX_PROBLEMS][GFX_PROBLEM_BYTES];
static uint32_t out_problem_count;
static uint32_t opcode_counts[256];
static uint32_t commands;
static GfxResult result;

static void problem(const char *fmt, ...) {
  if (out_problem_count >= GFX_MAX_PROBLEMS) return;
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(out_problems[out_problem_count++], GFX_PROBLEM_BYTES, fmt, ap);
  va_end(ap);
}

// ---- Memory image -------------------------------------------------------------------------------------------------

static const uint8_t *ram;
static size_t ram_len;

static inline uint32_t rd_u8(size_t p) { return p < ram_len ? ram[p] : 0u; }
static inline uint32_t rd_u16(size_t p) { return p + 2 <= ram_len ? ((uint32_t)ram[p] << 8) | ram[p + 1] : 0u; }
static inline uint32_t rd_u32(size_t p) {
  return p + 4 <= ram_len ? ((uint32_t)ram[p] << 24) | ((uint32_t)ram[p + 1] << 16) | ((uint32_t)ram[p + 2] << 8) | ram[p + 3] : 0u;
}
static inline int32_t rd_s16(size_t p) { return (int16_t)rd_u16(p); }
static inline int32_t rd_s8(size_t p) { return (int8_t)rd_u8(p); }

// ---- Interpreter state --------------------------------------------------------------------------------------------

typedef double Mat[16]; // 4x4, row-major, for row vectors

typedef struct {
  double clip[4];
  double color[4];
  double s, t;
} Vertex;

static uint32_t seg[16];
static Mat mv, proj, mvp;
static int mvp_valid;
static VEC(double) mv_stack; // sixteen doubles per entry
static Vertex verts[VERTEX_SLOTS];
static int vert_loaded[VERTEX_SLOTS];
static uint8_t tmem[TMEM_BYTES];
static struct { int32_t fmt, siz, width; uint32_t addr; } timg;
static GfxState st;
static int32_t fog_multiplier, fog_offset;
static int num_lights;
// Slot 0 and 1 are the look-at vectors, then the lights, then the ambient light.
static uint8_t light_slots[LIGHT_SLOTS][16];
static int snapshot_valid;
// The word of the last RDPHALF_1: the data pointer of a microcode about to be loaded, or the target of a branch on depth.
static uint32_t rdp_half1;
static int ucode_2d;
static int batch_open;
static uint32_t batch_first;

static void identity(Mat m) {
  memset(m, 0, sizeof(Mat));
  m[0] = m[5] = m[10] = m[15] = 1;
}

static void mul(const double *a, const double *b, double *o) {
  double r[16];
  for (int i = 0; i < 4; i++) for (int c = 0; c < 4; c++) {
    double s = 0;
    for (int k = 0; k < 4; k++) s += a[i * 4 + k] * b[k * 4 + c];
    r[i * 4 + c] = s;
  }
  memcpy(o, r, sizeof r);
}

static void invalidate(void) { snapshot_valid = 0; }

// Physical address of a segmented address, or -1 (and a problem) when it lies outside RAM.
static int64_t address(uint32_t a) {
  uint32_t p = seg[(a >> 24) & 15] + (a & 0xffffff);
  if (p >= ram_len) {
    problem("address 0x%x resolves outside RAM (0x%x)", a, p);
    return -1;
  }
  return p;
}

static inline int64_t at_least_zero(int64_t v) { return v < 0 ? 0 : v; }

// ---- Textures: cache --------------------------------------------------------------------------------------------

typedef struct {
  uint32_t id, width, height;
  uint8_t *rgba;
  // The run that last put the image in the result's texture table, and its index there.
  uint32_t stamp;
  uint32_t index;
} Texture;

typedef struct {
  int32_t fmt, siz, width, height, row_bytes, tlut_on, ia;
  uint32_t tex_hash, pal_hash;
  int32_t has_palette;
} TileKey;

typedef struct {
  uint64_t hash;
  TileKey key;
  Texture *tex; // NULL when the tile holds nothing to decode
} TileEntry;

typedef struct {
  uint32_t src, width, height, fmt, siz, sum;
  Texture *tex;
} BgEntry;

enum { TILE_INDEX_SIZE = 4096 };

static TileEntry tile_cache[TEXTURE_CACHE_LIMIT];
static int tile_cache_n;
static int16_t tile_index[TILE_INDEX_SIZE];
static int tile_index_ready;
static BgEntry bg_cache[BG_CACHE_ENTRIES];
static int bg_cache_n;
static uint32_t next_texture_id = 1;
static uint32_t run_stamp;
// Images dropped from the caches during a run; freed at the start of the next one, after the host has read the result.
static VEC(Texture *) retired;

static void retire(Texture *t) {
  if (t) VEC_PUSH(retired, t);
}

static void free_retired(void) {
  for (size_t i = 0; i < retired.n; i++) {
    free(retired.v[i]->rgba);
    free(retired.v[i]);
  }
  retired.n = 0;
}

static Texture *new_texture(uint32_t width, uint32_t height) {
  Texture *t = calloc(1, sizeof *t);
  if (!t) abort();
  t->id = next_texture_id++;
  t->width = width;
  t->height = height;
  t->rgba = malloc((size_t)width * height * 4 + 1);
  if (!t->rgba) abort();
  return t;
}

static void clear_tile_cache(void) {
  for (int i = 0; i < tile_cache_n; i++) retire(tile_cache[i].tex);
  tile_cache_n = 0;
  memset(tile_index, 0xff, sizeof tile_index);
  tile_index_ready = 1;
}

static void clear_bg_cache(void) {
  for (int i = 0; i < bg_cache_n; i++) retire(bg_cache[i].tex);
  bg_cache_n = 0;
}

// An index into the result's texture table for the image, -1 for none.
static int32_t texture_ref(Texture *t) {
  if (!t) return -1;
  if (t->stamp != run_stamp) {
    t->stamp = run_stamp;
    t->index = (uint32_t)out_textures.n;
    GfxTextureRef ref = { t->id, t->width, t->height, t->rgba };
    VEC_PUSH(out_textures, ref);
  }
  return (int32_t)t->index;
}

// ---- Texture memory ---------------------------------------------------------------------------------------------

// FNV-1a of `length` bytes from `start` (bytes past the end of the array count as zero).
static uint32_t hash_bytes(const uint8_t *data, size_t len, size_t start, size_t length) {
  uint32_t h = 0x811c9dc5u;
  for (size_t i = start; i < start + length; i++) h = (h ^ (i < len ? data[i] : 0u)) * 0x01000193u;
  return h;
}

// Hashes of ranges of the texture memory, valid until the next load into it.
enum { TMEM_HASH_SLOTS = 64 };
static struct { uint64_t key; uint32_t hash; uint32_t epoch; } tmem_hashes[TMEM_HASH_SLOTS];
static uint32_t tmem_epoch = 1;

static uint32_t tmem_hash(size_t start, size_t length) {
  uint64_t key = (uint64_t)start * 65536 + length;
  unsigned slot = (unsigned)((start * 31 + length) % TMEM_HASH_SLOTS);
  if (tmem_hashes[slot].epoch == tmem_epoch && tmem_hashes[slot].key == key) return tmem_hashes[slot].hash;
  uint32_t h = hash_bytes(tmem, TMEM_BYTES, start, length);
  tmem_hashes[slot].key = key;
  tmem_hashes[slot].hash = h;
  tmem_hashes[slot].epoch = tmem_epoch;
  return h;
}

// Bytes a row of `texels` texels takes in an image of the given size.
static int64_t row_bytes_of(int64_t texels, int32_t siz) {
  int64_t bits = texels * (4 << siz);
  return bits >= 0 ? (bits + 7) / 8 : -((-bits) / 8);
}

static void store(int64_t dest, int64_t src, int64_t bytes) {
  int64_t d = dest & (TMEM_BYTES - 1);
  int64_t n = bytes;
  if (TMEM_BYTES - d < n) n = TMEM_BYTES - d;
  if ((int64_t)ram_len - src < n) n = (int64_t)ram_len - src;
  if (n < 0) n = 0;
  if (n > 0) memcpy(tmem + d, ram + src, (size_t)n);
  tmem_epoch++;
  invalidate();
}

static uint64_t tile_key_hash(const TileKey *k) {
  uint64_t h = 1469598103934665603ull;
  const uint32_t words[] = { (uint32_t)k->fmt, (uint32_t)k->siz, (uint32_t)k->width, (uint32_t)k->height, (uint32_t)k->row_bytes,
    (uint32_t)k->tlut_on, (uint32_t)k->ia, k->tex_hash, k->pal_hash, (uint32_t)k->has_palette };
  for (size_t i = 0; i < sizeof words / sizeof words[0]; i++) h = (h ^ words[i]) * 1099511628211ull;
  return h ^ (h >> 29);
}

static Texture *decode_tile(int index) {
  const GfxTile *t = &st.tiles[index];
  if (t->line == 0 || t->fmt == GFX_FMT_YUV) return NULL;
  const int tlut_type = (int)((st.other_h >> 14) & 3);
  const int tlut_on = tlut_type != 0;
  const int ia = tlut_type == 3;
  const int row_bytes = t->line * (t->siz == GFX_SIZ_32 ? 16 : 8);
  const int bits = 4 << t->siz;
  int width = t->sized ? ((t->lrs - t->uls) >> 2) + 1 : t->mask_s ? 1 << t->mask_s : (row_bytes * 8) / bits;
  int height = t->sized ? ((t->lrt - t->ult) >> 2) + 1 : t->mask_t ? 1 << t->mask_t : 1;
  const int max_height = (TMEM_BYTES - t->tmem * 8) / row_bytes;
  const int per_row = (row_bytes * 8) / bits;
  width = width < per_row ? width : per_row;
  if (width < 1) width = 1;
  height = height < max_height ? height : max_height;
  if (height < 0) height = 0;
  // The image depends only on the texel bytes, the palette and the format, so equal contents share one decode across lists.
  const int ci = t->fmt == GFX_FMT_CI;
  const size_t palette = ci ? (size_t)(256 + (t->siz == GFX_SIZ_4 ? t->palette * 16 : 0)) * 8 : 0;
  const size_t palette_bytes = t->siz == GFX_SIZ_4 ? 32 : 512;
  TileKey key = {
    t->fmt, t->siz, width, height, row_bytes, tlut_on, ia,
    tmem_hash((size_t)t->tmem * 8, (size_t)row_bytes * (size_t)height), ci ? tmem_hash(palette, palette_bytes) : 0, ci,
  };
  if (!tile_index_ready) clear_tile_cache();
  const uint64_t h = tile_key_hash(&key);
  unsigned slot = (unsigned)(h % TILE_INDEX_SIZE);
  for (; tile_index[slot] >= 0; slot = (slot + 1) % TILE_INDEX_SIZE) {
    const TileEntry *e = &tile_cache[tile_index[slot]];
    if (e->hash == h && memcmp(&e->key, &key, sizeof key) == 0) return e->tex;
  }
  Texture *out = NULL;
  if (height > 0) {
    out = new_texture((uint32_t)width, (uint32_t)height);
    GfxTextureSource src = {
      t->fmt, t->siz, width, height, row_bytes, tmem, TMEM_BYTES, (size_t)t->tmem * 8,
      tmem, TMEM_BYTES, palette, ia,
    };
    gfx_decode_texture(&src, out->rgba);
  }
  if (tile_cache_n >= TEXTURE_CACHE_LIMIT) {
    clear_tile_cache();
    slot = (unsigned)(h % TILE_INDEX_SIZE);
    while (tile_index[slot] >= 0) slot = (slot + 1) % TILE_INDEX_SIZE;
  }
  tile_cache[tile_cache_n].hash = h;
  tile_cache[tile_cache_n].key = key;
  tile_cache[tile_cache_n].tex = out;
  tile_index[slot] = (int16_t)tile_cache_n++;
  return out;
}

// ---- Render state snapshots and batches -------------------------------------------------------------------------

static uint32_t take_snapshot(int texture_tile) {
  GfxState s = st;
  s.texture_ref_tile[0] = texture_tile;
  s.texture_ref_tile[1] = (texture_tile + 1) & 7;
  s.texture_ref[0] = texture_ref(decode_tile(s.texture_ref_tile[0]));
  s.texture_ref[1] = texture_ref(decode_tile(s.texture_ref_tile[1]));
  VEC_PUSH(out_states, s);
  snapshot_valid = 1;
  return (uint32_t)(out_states.n - 1);
}

static void finish_batch(void) {
  if (!batch_open) return;
  batch_open = 0;
  if (out_pos.n / 4 == batch_first) return;
  GfxBatch b;
  memset(&b, 0, sizeof b);
  b.kind = GFX_BATCH_TRIANGLES;
  b.state = (uint32_t)out_states.n - 1;
  b.first_vertex = batch_first;
  b.vertex_count = (uint32_t)(out_pos.n / 4) - batch_first;
  VEC_PUSH(out_batches, b);
}

// The batch triangles go into: the one begun with the render state in force, until a command changes that state.
static void current_batch(void) {
  if (batch_open && snapshot_valid) return;
  finish_batch();
  take_snapshot(st.texture_tile);
  batch_open = 1;
  batch_first = (uint32_t)(out_pos.n / 4);
}

// ---- Lighting -----------------------------------------------------------------------------------------------------

// The inverse square root table of the vector unit's divide unit: 512 entries of 16 bits. The entry for index i is
// floor(b / 2) where b is the largest integer below 2^22 / sqrt(a) with a = (i + 512) >> (i & 1).
static uint16_t inverse_square_root_table[512];
static int inverse_square_root_ready;

static void build_inverse_square_root(void) {
  for (int i = 0; i < 512; i++) {
    int a = (i + 512) >> (i & 1);
    inverse_square_root_table[i] = (uint16_t)(((int64_t)ceil(sqrt(17592186044416.0 / a)) - 1) >> 1);
  }
  inverse_square_root_ready = 1;
}

// The reciprocal square root of the vector unit's divide unit, for a 32-bit integer: about 2^31 / sqrt(x) times sqrt(2) for odd
// exponents folded into the table, and 0x7FFFFFFF for 0. The index is the nine bits after the leading one of the input, with
// the lowest replaced by the parity of the leading zero count (n64brew.dev, RSP divide unit). Its precision is what makes the
// lighting vectors a unit less than exact.
static uint32_t reciprocal_square_root(double input_d) {
  if (input_d == 0) return 0x7fffffff;
  if (!inverse_square_root_ready) build_inverse_square_root();
  uint32_t input = to_u32(input_d);
  int shift = input ? __builtin_clz(input) : 32;
  uint32_t shifted = shift >= 32 ? input : input << shift;
  uint32_t index = (shifted & 0x7fc00000u) >> 22;
  uint32_t entry = inverse_square_root_table[(index & 0x1fe) | (uint32_t)(shift & 1)];
  uint32_t value = (0x10000 | entry) << 14;
  int count = (31 - shift) >> 1;
  return value >> (count & 31);
}

// The direction of a light or look-at slot in the model's space, in the units of a normal's bytes (127 for a unit vector).
// The microcode multiplies the slot's direction bytes by the 3x3 part of the model-view matrix into a 24.8 fixed-point
// vector V, sums the squares of its components (each truncated to an integer, S = sum of floor(V^2 / 65536)) and scales V by
// the reciprocal square root of S (1 when S is below 2), keeping half of it and saturating each component to a byte. A
// matrix that scales so that the vector stays below about 1.6 long therefore gives a vector that is not of unit length: the
// game's actor matrices (scale 0.01) make the light about 1.2 times as strong as a unit vector, and a scale far below
// that dims it.
static void model_direction(int slot, int32_t out[3]) {
  const uint8_t *l = light_slots[slot];
  const double d[3] = { (int8_t)l[8], (int8_t)l[9], (int8_t)l[10] };
  double v[3];
  double sum = 0;
  for (int i = 0; i < 3; i++) {
    v[i] = floor((d[0] * mv[i * 4] + d[1] * mv[i * 4 + 1] + d[2] * mv[i * 4 + 2]) * 256);
    sum = sum + floor((v[i] * v[i]) / 65536.0);
  }
  const double scale = reciprocal_square_root(sum);
  for (int i = 0; i < 3; i++) out[i] = (int32_t)js_max(-128, js_min(127, floor((v[i] * scale) / 4294967296.0)));
}

static inline int32_t along(const int32_t n[3], const int32_t d[3]) { return n[0] * d[0] + n[1] * d[1] + n[2] * d[2]; }

// Lit colour in 0..1: the ambient colour plus, for each light, its colour times the cosine of the angle to the normal. The
// cosine is the dot product of the normal's bytes with the light's model-space vector over 2^14, 0 when facing away and at
// most 1 - 2^-15; each product is truncated to a whole number of 1/255 steps before the sum, which is capped at 255.
static void light(const int32_t n[3], int32_t dirs[][3], double out[3]) {
  const uint8_t *amb = light_slots[2 + num_lights];
  double c[3] = { amb[0], amb[1], amb[2] };
  for (int i = 0; i < num_lights; i++) {
    double d = js_min(32767, js_max(0, (double)(along(n, dirs[2 + i]) * 2)));
    const uint8_t *l = light_slots[2 + i];
    for (int k = 0; k < 3; k++) c[k] += floor((l[k] * d) / 32768.0);
  }
  for (int k = 0; k < 3; k++) out[k] = js_min(255, c[k]) / 255;
}

// A texture coordinate in 10.5 fixed point times the texture command's scale (a 16-bit fraction), rounded down.
static double scale_coordinate(double coordinate, uint32_t scale) { return floor((coordinate * scale) / 65536.0); }

// The coordinate texture generation makes from `along`, the dot product of the normal with a look-at vector in the model's
// space (at most 127 * 127), in 10.5 fixed point before scaling: `0x3FFF + along` for the plain mode and, in the linear
// mode, a cubic `0x4000 + 8672 x + 7226 x^3` of `x = along / 16129` fitted to the microcode's output (largest difference 2.3
// of 32768).
static double generated_coordinate(int32_t a, int linear) {
  if (!linear) return 0x3fff + a;
  double x = js_max(-1, js_min(1, a / 16129.0));
  return (0x4000 + 8672 * x) + ((7226 * x) * x) * x;
}

// Fog factor 0..1 of a vertex: `clamp(z / w * multiplier + offset, 0, 255) / 255`. A vertex at or behind the eye (w <= 0)
// is treated as infinitely far in front of the near plane (the depth the microcode stores for it is the lowest), so the
// factor is the clamp of the offset alone when the multiplier is zero, 0 for a positive multiplier and 1 for a negative one.
static double fog_factor(const double clip[4]) {
  const double w = clip[3];
  double value;
  if (w > 0) value = (clip[2] / w) * fog_multiplier + fog_offset;
  else value = fog_multiplier == 0 ? (double)fog_offset : fog_multiplier > 0 ? -INFINITY : INFINITY;
  return js_min(255, js_max(0, value)) / 255;
}

// ---- Matrices and vertices ------------------------------------------------------------------------------------------

// A 4x4 matrix in the game's fixed-point layout: sixteen s16 integer parts, then sixteen u16 fractions.
static void read_matrix(size_t addr, double *m) {
  for (int i = 0; i < 16; i++) m[i] = rd_s16(addr + i * 2) + rd_u16(addr + 32 + i * 2) / 65536.0;
}

// ---- Matrix identity ------------------------------------------------------------------------------------------------
//
// A matrix is named by where the display list loads it, so that the same matrix of two consecutive frames gets the same
// name although the game places the frame's matrices and dynamic lists at different addresses. The name combines the path
// of calls that led to the command with the command's place in the list it is in:
//   - a call or branch to a segmented address adds that address to the path (the object and scene files sit behind
//     segments, and their offsets repeat from frame to frame); one to any other address adds nothing, because the lists the
//     game builds anew each frame are laid out at addresses and in numbers that change from frame to frame;
//   - a command in a list entered through a segmented address is named by its offset from the list's start;
//   - a command in any other list is named by what the list does next: the first call or vertex load after it, and the
//     matrix commands passed on the way.
// Commands of one name (the same limb list drawn for two actors) are told apart by their ordinal, the count of commands of
// that name before them in the run; whoever pairs matrices of two frames decides how to pair names that occur a different
// number of times.

typedef struct {
  uint64_t hash;
  // Physical start of a list entered through a segmented address, -1 for a list built anew each frame.
  int64_t entry;
} ListContext;

static ListContext context;
static size_t command_at;

enum { COUNTER_SLOTS = 8192 };
static struct { uint64_t key; uint32_t count, stamp; } counters[COUNTER_SLOTS];

static uint64_t mix(uint64_t h, uint64_t v) {
  h ^= v + 0x9e3779b97f4a7c15ull + (h << 6) + (h >> 2);
  h *= 0xff51afd7ed558ccdull;
  return h ^ (h >> 32);
}

// How many times `key` was used before in this run (the table is emptied by the run stamp).
static uint32_t use_count(uint64_t key) {
  size_t i = (size_t)(key & (COUNTER_SLOTS - 1));
  for (size_t probes = 0; probes < COUNTER_SLOTS; probes++, i = (i + 1) & (COUNTER_SLOTS - 1)) {
    if (counters[i].stamp != run_stamp) {
      counters[i].key = key;
      counters[i].stamp = run_stamp;
      counters[i].count = 1;
      return 0;
    }
    if (counters[i].key == key) return counters[i].count++;
  }
  return 0xffffffffu;
}

static int segmented(uint32_t a) { return ((a >> 24) & 15) != 0; }

// The context of the list that a call or branch to `target_word` (resolved to `target`) enters from the current one.
static ListContext enter_list(uint32_t target_word, int64_t target) {
  ListContext c = context;
  if (segmented(target_word)) {
    c.hash = mix(context.hash, target_word);
    c.entry = target;
  } else c.entry = -1;
  return c;
}

// What the list does after the command at `from`: the first call or vertex load, with the matrix commands passed on the way.
static uint64_t what_follows(size_t from) {
  uint64_t h = 0;
  for (int i = 0; i < 32 && from + 8 <= ram_len; i++, from += 8) {
    const uint32_t op = rd_u8(from);
    if (op == OP_DL || op == OP_VTX) {
      const uint32_t w1 = rd_u32(from + 4);
      return mix(mix(h, op), segmented(w1) ? w1 : 0);
    }
    if (op == OP_ENDDL) break;
    if (op == OP_MTX || op == OP_POPMTX) h = mix(h, op);
  }
  return mix(h, OP_ENDDL);
}

// 53 bits, so that JS holds a name exactly in a number.
#define NAME_MASK ((1ull << 53) - 1)

static uint64_t matrix_name(size_t at, uint32_t params, uint32_t *ordinal) {
  const uint64_t place = context.entry >= 0 ? (uint64_t)(at - (size_t)context.entry) : what_follows(at + 8);
  const uint64_t name = mix(mix(mix(context.hash, context.entry >= 0), place), params) & NAME_MASK;
  *ordinal = use_count(name);
  return name;
}

// ---- Matrix record and overrides -------------------------------------------------------------------------------------

static int motion_record;
static VEC(GfxMatrix) matrix_record;
static VEC(GfxVertexLoad) vertex_load_record;
static VEC(GfxMatrix) override_input;
static GfxMatrix *override_table;
static size_t override_slots;

void gfx_motion_record(uint32_t on) { motion_record = on != 0; }
uint32_t gfx_motion_count(void) { return (uint32_t)matrix_record.n; }
const GfxMatrix *gfx_motion_matrices(void) { return matrix_record.v; }
uint32_t gfx_motion_vertex_load_count(void) { return (uint32_t)vertex_load_record.n; }
const GfxVertexLoad *gfx_motion_vertex_loads(void) { return vertex_load_record.v; }

static uint64_t name_of(const GfxMatrix *m) { return ((uint64_t)m->name_hi << 32) | m->name_lo; }
static size_t slot_of_name(uint64_t name, uint32_t ordinal) { return (size_t)(mix(name, ordinal) & (override_slots - 1)); }

// Space for `n` override matrices, which the caller fills in and then passes to gfx_motion_commit.
GfxMatrix *gfx_motion_input(uint32_t n) {
  override_input.v = grow(override_input.v, &override_input.cap, n ? n : 1, sizeof(GfxMatrix));
  return override_input.v;
}

// From the next run on, a matrix command with the name and ordinal of one of the first `n` matrices of the input loads that
// matrix instead of the one in memory. With n = 0 nothing is replaced.
void gfx_motion_commit(uint32_t n) {
  free(override_table);
  override_table = NULL;
  override_slots = 0;
  if (n == 0) return;
  override_slots = 16;
  while (override_slots < (size_t)n * 2) override_slots *= 2;
  override_table = calloc(override_slots, sizeof(GfxMatrix));
  if (!override_table) abort();
  for (uint32_t i = 0; i < n; i++) {
    size_t at = slot_of_name(name_of(&override_input.v[i]), override_input.v[i].ordinal);
    while (override_table[at].flags & GFX_MTX_PRESENT) at = (at + 1) & (override_slots - 1);
    override_table[at] = override_input.v[i];
    override_table[at].flags |= GFX_MTX_PRESENT;
  }
}

static const GfxMatrix *override_for(uint64_t name, uint32_t ordinal) {
  if (!override_table) return NULL;
  size_t at = slot_of_name(name, ordinal);
  for (size_t probes = 0; probes < override_slots; probes++, at = (at + 1) & (override_slots - 1)) {
    const GfxMatrix *slot = &override_table[at];
    if (!(slot->flags & GFX_MTX_PRESENT)) return NULL;
    if (slot->ordinal == ordinal && name_of(slot) == name) return slot;
  }
  return NULL;
}

// A perspective projection divides by depth, which puts a non-zero in the third row's last column; an orthographic one does not.
static int perspective(const double *p) { return p[11] != 0; }

static void load_matrix(uint32_t w0, uint32_t w1, size_t at) {
  // The push bit is stored inverted.
  const uint32_t params = (w0 & 0xff) ^ MTX_PUSH;
  const int64_t addr = address(w1);
  if (addr < 0 || (size_t)addr + 64 > ram_len) return;
  Mat m;
  read_matrix((size_t)addr, m);
  uint32_t ordinal;
  const uint64_t name = matrix_name(at, params, &ordinal);
  if (!motion_record) {
    const GfxMatrix *o = override_for(name, ordinal);
    if (o) memcpy(m, o->m, sizeof m);
  }
  if (params & MTX_PROJECTION) {
    if (params & MTX_LOAD) memcpy(proj, m, sizeof m);
    else mul(m, proj, proj);
  } else {
    if (params & MTX_PUSH) {
      mv_stack.v = grow(mv_stack.v, &mv_stack.cap, mv_stack.n + 16, sizeof(double));
      memcpy(mv_stack.v + mv_stack.n, mv, sizeof mv);
      mv_stack.n += 16;
    }
    if (params & MTX_LOAD) memcpy(mv, m, sizeof m);
    else mul(m, mv, mv);
  }
  mvp_valid = 0;
  if (motion_record) {
    GfxMatrix r;
    r.name_lo = (uint32_t)name;
    r.name_hi = (uint32_t)(name >> 32);
    r.ordinal = ordinal;
    r.flags = ((params & MTX_PROJECTION) ? GFX_MTX_PROJECTION : 0) | ((params & MTX_LOAD) ? GFX_MTX_LOAD : 0) | ((params & MTX_PUSH) ? GFX_MTX_PUSH : 0) |
      (perspective(proj) ? GFX_MTX_PERSPECTIVE : 0);
    r.source = (uint32_t)addr;
    r.reserved = 0;
    memcpy(r.m, m, sizeof m);
    VEC_PUSH(matrix_record, r);
  }
}

static void pop_matrix(uint32_t w1) {
  for (double n = w1 / 64.0; n > 0; n--) {
    if (mv_stack.n >= 16) {
      mv_stack.n -= 16;
      memcpy(mv, mv_stack.v + mv_stack.n, sizeof mv);
    } else problem("matrix stack underflow");
  }
  mvp_valid = 0;
}

// Vertex trace, for tests: while on, every vertex load appends the doubles (w0, first slot, count) and then, per loaded vertex,
// clip x y z w, colour r g b a, s, t.
static VEC(double) vertex_trace;
static int vertex_trace_on;

static void load_vertices(uint32_t w0, uint32_t w1) {
  const int n = (int)((w0 >> 12) & 0xff);
  const int v0 = (int)((w0 >> 1) & 0x7f) - n;
  const int64_t addr = address(w1);
  if (addr < 0) return;
  if (v0 < 0 || v0 + n > VERTEX_SLOTS) {
    problem("vertex load of %d at %d does not fit the buffer", n, v0);
    return;
  }
  if ((size_t)addr + (size_t)n * 16 > ram_len) return;
  if (!mvp_valid) {
    mul(mv, proj, mvp);
    mvp_valid = 1;
  }
  const double *m = mvp;
  if (motion_record) {
    uint32_t h = 2166136261u;
    for (size_t i = 0; i < (size_t)n * 16; i++) h = (h ^ ram[(size_t)addr + i]) * 16777619u;
    GfxVertexLoad load = { h, (uint32_t)n };
    VEC_PUSH(vertex_load_record, load);
  }
  const int lighting = (st.geometry_mode & GEO_LIGHTING) != 0;
  const int texgen = (st.geometry_mode & GEO_TEXTURE_GEN) != 0;
  const int linear = (st.geometry_mode & GEO_TEXTURE_GEN_LINEAR) != 0;
  const int fog_on = (st.geometry_mode & GEO_FOG) != 0;
  // Light and look-at directions depend on the model-view matrix and the slots only, so they serve every vertex of the load.
  int32_t dirs[2 + 7][3];
  if (lighting) {
    if (texgen) for (int i = 0; i < 2; i++) model_direction(i, dirs[i]);
    for (int i = 0; i < num_lights; i++) model_direction(2 + i, dirs[2 + i]);
  }
  for (int i = 0; i < n; i++) {
    const size_t a = (size_t)addr + (size_t)i * 16;
    const double x = rd_s16(a), y = rd_s16(a + 2), z = rd_s16(a + 4);
    Vertex *v = &verts[v0 + i];
    v->clip[0] = x * m[0] + y * m[4] + z * m[8] + m[12];
    v->clip[1] = x * m[1] + y * m[5] + z * m[9] + m[13];
    v->clip[2] = x * m[2] + y * m[6] + z * m[10] + m[14];
    v->clip[3] = x * m[3] + y * m[7] + z * m[11] + m[15];
    double alpha = rd_u8(a + 15) / 255.0;
    double col[3];
    double s = scale_coordinate(rd_s16(a + 8), st.texture_scale_s);
    double t = scale_coordinate(rd_s16(a + 10), st.texture_scale_t);
    if (lighting) {
      const int32_t normal[3] = { rd_s8(a + 12), rd_s8(a + 13), rd_s8(a + 14) };
      light(normal, dirs, col);
      if (texgen) {
        s = scale_coordinate(generated_coordinate(along(normal, dirs[0]), linear), st.texture_scale_s);
        t = scale_coordinate(generated_coordinate(along(normal, dirs[1]), linear), st.texture_scale_t);
      }
    } else {
      col[0] = rd_u8(a + 12) / 255.0;
      col[1] = rd_u8(a + 13) / 255.0;
      col[2] = rd_u8(a + 14) / 255.0;
    }
    // With the fog bit the vertex's alpha byte carries the fog factor instead.
    if (fog_on) alpha = fog_factor(v->clip);
    v->color[0] = col[0];
    v->color[1] = col[1];
    v->color[2] = col[2];
    v->color[3] = alpha;
    v->s = s / 32;
    v->t = t / 32;
    vert_loaded[v0 + i] = 1;
  }
  if (vertex_trace_on) {
    VEC_PUSH(vertex_trace, (double)w0);
    VEC_PUSH(vertex_trace, (double)v0);
    VEC_PUSH(vertex_trace, (double)n);
    for (int i = 0; i < n; i++) {
      const Vertex *v = &verts[v0 + i];
      for (int k = 0; k < 4; k++) VEC_PUSH(vertex_trace, v->clip[k]);
      for (int k = 0; k < 4; k++) VEC_PUSH(vertex_trace, v->color[k]);
      VEC_PUSH(vertex_trace, v->s);
      VEC_PUSH(vertex_trace, v->t);
    }
  }
}

// MODIFYVTX: overwrites a field of a loaded vertex (fields observed by running the microcode, docs/re/display-lists.md section 9; the
// screen position and depth are converted back to clip space with the viewport, which is this interpreter's own inverse). `w0[23:16]` names the field and `w0[15:0] / 2` the slot: 0x10 the colour
// (`w1` = rgba), 0x14 the texture coordinates (`w1` = s in the high half, t in the low, S10.5, not scaled), 0x18 the screen
// position in 10.2 pixel units (x high, y low) and 0x1C the screen depth (high half).
static void modify_vertex(uint32_t w0, uint32_t w1) {
  const uint32_t slot2 = w0 & 0xffff;
  if ((slot2 & 1) || slot2 / 2 >= VERTEX_SLOTS || !vert_loaded[slot2 / 2]) {
    char num[16];
    format_number(num, sizeof num, slot2 / 2.0);
    problem("vertex modification of slot %s that is not loaded", num);
    return;
  }
  Vertex *v = &verts[slot2 / 2];
  const uint32_t where = (w0 >> 16) & 0xff;
  const int32_t *vp = st.viewport;
  const double w = v->clip[3];
  if (where == 0x10) {
    v->color[0] = (w1 >> 24) / 255.0;
    v->color[1] = ((w1 >> 16) & 255) / 255.0;
    v->color[2] = ((w1 >> 8) & 255) / 255.0;
    v->color[3] = (w1 & 255) / 255.0;
  } else if (where == 0x14) {
    v->s = ((int32_t)w1 >> 16) / 32.0;
    v->t = (int16_t)(w1 & 0xffff) / 32.0;
  } else if (where == 0x18 && vp[0] != 0 && vp[1] != 0) {
    v->clip[0] = (((double)((int32_t)w1 >> 16) - vp[3]) / vp[0]) * w;
    v->clip[1] = -(((double)(int16_t)(w1 & 0xffff) - vp[4]) / vp[1]) * w;
  } else if (where == 0x1c && vp[2] != 0) {
    v->clip[2] = (((double)((w1 >> 16) * 4) - vp[5]) / vp[2]) * w;
  } else problem("vertex modification of unknown field 0x%x", where);
}

// The microcode's clip flags of a vertex that decide trivial rejection: for x and for y a bit for `v <= -w` and one for
// `v >= w` (the comparison of the vector unit's clip instruction, which treats a negative w by flipping both senses),
// plus `w <= 0` and `z >= w` (beyond the far plane). The near plane (`z <= -w`) has no flag in the rejection mask.
static int clip_side(double c, double w) {
  const int opposite = (c < 0) != (w < 0);
  return ((opposite ? c + w <= 0 : w < 0) ? 1 : 0) | ((opposite ? w < 0 : c - w >= 0) ? 2 : 0);
}

static int clip_flags(const Vertex *v) {
  const double x = v->clip[0], y = v->clip[1], z = v->clip[2], w = v->clip[3];
  return clip_side(x, w) | (clip_side(y, w) << 2) | (w <= 0 ? 16 : 0) | (z >= w ? 32 : 0);
}

// CULLDL: the list ends when every vertex of the range shares a clip flag (all outside one side of the view volume).
static int cull_list(uint32_t w0, uint32_t w1) {
  const double first = (w0 & 0xffff) / 2.0;
  const double last = (w1 & 0xffff) / 2.0;
  int all = 63;
  for (double i = first; i <= last; i++) {
    if (i != floor(i) || i >= VERTEX_SLOTS || !vert_loaded[(int)i]) {
      char num[16];
      format_number(num, sizeof num, i);
      problem("cull range uses vertex %s that is not loaded", num);
      return 0;
    }
    all &= clip_flags(&verts[(int)i]);
  }
  return all != 0;
}

// ---- Clipping -----------------------------------------------------------------------------------------------------

// Signed distances of a vertex from the planes, positive inside, in the order the clipper takes them.
static double guard_distance(int plane, const Vertex *v) {
  switch (plane) {
    case 0: return v->clip[0] + GUARD_BAND * v->clip[3];
    case 1: return v->clip[1] + GUARD_BAND * v->clip[3];
    case 2: return GUARD_BAND * v->clip[3] - v->clip[0];
    case 3: return GUARD_BAND * v->clip[3] - v->clip[1];
    default: return v->clip[3] - v->clip[2];
  }
}

static int outside_guard_band(const Vertex *v) {
  if (v->clip[3] <= 0) return 1;
  for (int p = 0; p < 5; p++) if (guard_distance(p, v) < 0) return 1;
  return 0;
}

static void interpolate(const Vertex *a, const Vertex *b, double t, Vertex *o) {
  for (int i = 0; i < 4; i++) o->clip[i] = a->clip[i] + (b->clip[i] - a->clip[i]) * t;
  for (int i = 0; i < 4; i++) o->color[i] = a->color[i] + (b->color[i] - a->color[i]) * t;
  o->s = a->s + (b->s - a->s) * t;
  o->t = a->t + (b->t - a->t) * t;
}

enum { MAX_POLYGON = 16 };

// Clips a triangle to the guard band, one plane after the other. The polygon starts at the triangle's third vertex and each
// plane's pass walks it emitting, for every vertex, the crossing with the edge from the one before it and then the vertex when
// it is inside; this reproduces which vertex the microcode's fan of triangles starts from (the fan's first vertex fixes how
// the shade is interpolated across a clipped floor). Returns the number of vertices of the result, in `poly`.
static int clip_to_guard_band(const Vertex *a, const Vertex *b, const Vertex *c, Vertex *poly) {
  Vertex tmp[MAX_POLYGON];
  poly[0] = *c;
  poly[1] = *a;
  poly[2] = *b;
  int n = 3;
  for (int plane = 0; plane < 5; plane++) {
    int m = 0;
    for (int i = 0; i < n; i++) {
      const Vertex *prev = &poly[(i + n - 1) % n], *cur = &poly[i];
      const double dp = guard_distance(plane, prev), dc = guard_distance(plane, cur);
      if (dc >= 0) {
        if (dp < 0) interpolate(prev, cur, dp / (dp - dc), &tmp[m++]);
        tmp[m++] = *cur;
      } else if (dp >= 0) interpolate(prev, cur, dp / (dp - dc), &tmp[m++]);
    }
    n = m;
    if (n < 3) return 0;
    memcpy(poly, tmp, sizeof(Vertex) * (size_t)n);
  }
  return n;
}

// ---- Primitives ---------------------------------------------------------------------------------------------------

static inline int slot_of(uint32_t byte_index, const Vertex **out) {
  if ((byte_index & 1) || byte_index / 2 >= VERTEX_SLOTS || !vert_loaded[byte_index / 2]) return 0;
  *out = &verts[byte_index / 2];
  return 1;
}

static void emit(const Vertex *v) {
  for (int i = 0; i < 4; i++) VEC_PUSH(out_pos, (float)v->clip[i]);
  for (int i = 0; i < 4; i++) VEC_PUSH(out_col, (float)v->color[i]);
  VEC_PUSH(out_uv, (float)v->s);
  VEC_PUSH(out_uv, (float)v->t);
}

// A triangle is dropped when its three vertices share a clip flag (all outside one side of the view volume, or all at or
// behind the eye, or all beyond the far plane). Otherwise, if any vertex lies outside the guard band (beyond twice w to a
// side, behind the eye or past the far plane) the polygon is clipped to it as the microcode's clipper does: against the
// planes in the order x low, y low, x high, y high, far, each new vertex taking the linear interpolation, in clip space,
// of every field of the edge's two vertices (position, colour, fog factor and texture coordinates); the polygon is then
// drawn as a fan. In front of the near plane nothing is clipped.
static void triangle(uint32_t a, uint32_t b, uint32_t c) {
  const Vertex *v0, *v1, *v2;
  if (!slot_of(a, &v0) || !slot_of(b, &v1) || !slot_of(c, &v2)) {
    char na[16], nb[16], nc[16];
    format_number(na, sizeof na, a / 2.0);
    format_number(nb, sizeof nb, b / 2.0);
    format_number(nc, sizeof nc, c / 2.0);
    problem("triangle uses vertices %s, %s, %s that are not loaded", na, nb, nc);
    return;
  }
  if ((clip_flags(v0) & clip_flags(v1) & clip_flags(v2)) != 0) return;
  Vertex clipped[MAX_POLYGON];
  const Vertex *polygon[MAX_POLYGON];
  int n = 3;
  polygon[0] = v0;
  polygon[1] = v1;
  polygon[2] = v2;
  if (outside_guard_band(v0) || outside_guard_band(v1) || outside_guard_band(v2)) {
    n = clip_to_guard_band(v0, v1, v2, clipped);
    for (int i = 0; i < n; i++) polygon[i] = &clipped[i];
  }
  if (n < 3) return;
  current_batch();
  for (int k = 1; k + 1 < n; k++) {
    emit(polygon[0]);
    emit(polygon[k]);
    emit(polygon[k + 1]);
  }
}

static void push_rect_batch(uint32_t kind, uint32_t state, int32_t xl, int32_t yl, int32_t xh, int32_t yh, int32_t tile, int32_t s, int32_t t, int32_t dsdx, int32_t dtdy) {
  GfxBatch b = { kind, state, 0, 0, xl, yl, xh, yh, tile, s, t, dsdx, dtdy };
  VEC_PUSH(out_batches, b);
}

static void tex_rect(uint32_t w0, uint32_t w1, uint32_t half1, uint32_t half2) {
  finish_batch();
  const int tile = (int)((w1 >> 24) & 7);
  const uint32_t state = take_snapshot(tile);
  push_rect_batch(GFX_BATCH_TEXRECT, state, (int32_t)((w0 >> 12) & 0xfff), (int32_t)(w0 & 0xfff), (int32_t)((w1 >> 12) & 0xfff), (int32_t)(w1 & 0xfff), tile,
    (int32_t)half1 >> 16, (int16_t)(half1 & 0xffff), (int32_t)half2 >> 16, (int16_t)(half2 & 0xffff));
}

static void fill_rect(uint32_t w0, uint32_t w1) {
  finish_batch();
  const uint32_t state = take_snapshot(st.texture_tile);
  push_rect_batch(GFX_BATCH_FILLRECT, state, (int32_t)((w0 >> 12) & 0xfff), (int32_t)(w0 & 0xfff), (int32_t)((w1 >> 12) & 0xfff), (int32_t)(w1 & 0xfff), 0, 0, 0, 0, 0);
}

// True when the 1 KiB at the segmented address holds the text `signature`.
static int has_signature(uint32_t a, const char *signature) {
  const int64_t p = address(a);
  if (p < 0) return 0;
  const size_t len = strlen(signature);
  size_t limit = (size_t)p + MICROCODE_DATA_SCAN < ram_len ? (size_t)p + MICROCODE_DATA_SCAN : ram_len;
  if (limit < len) return 0;
  const size_t end = limit - len;
  for (size_t i = (size_t)p; i <= end; i++) if (memcmp(ram + i, signature, len) == 0) return 1;
  return 0;
}

static GfxTile new_tile(void) {
  GfxTile t;
  memset(&t, 0, sizeof t);
  return t;
}

// A background picture command of the 2D microcode: `w1` addresses a 40-byte record (layout in docs/re/display-lists.md).
// The microcode answers with strips of texture rectangles; here the whole picture is one texture rectangle, whose
// cycle type is the one the game set.
static void background(uint32_t op, uint32_t w1) {
  const int64_t at64 = address(w1);
  if (at64 < 0 || (size_t)at64 + BG_RECORD_BYTES > ram_len) return;
  const size_t at = (size_t)at64;
  const int32_t image_x = (int32_t)rd_u16(at), image_w = (int32_t)rd_u16(at + 2), frame_x = rd_s16(at + 4), frame_w = (int32_t)rd_u16(at + 6);
  const int32_t image_y = (int32_t)rd_u16(at + 8), image_h = (int32_t)rd_u16(at + 10), frame_y = rd_s16(at + 12), frame_h = (int32_t)rd_u16(at + 14);
  const int32_t fmt = (int32_t)rd_u8(at + 22), siz = (int32_t)rd_u8(at + 23);
  const int32_t width = image_w >> 2, height = image_h >> 2;
  const int64_t src = address(rd_u32(at + 16));
  if (src < 0 || width == 0 || height == 0 || fmt == GFX_FMT_CI || fmt == GFX_FMT_YUV) {
    if (src >= 0) problem("background picture with unsupported format %d/%d or size %dx%d", fmt, siz, width, height);
    return;
  }
  const int64_t row_bytes = row_bytes_of(width, siz);
  int64_t bytes = row_bytes * height;
  if ((int64_t)ram_len - src < bytes) bytes = (int64_t)ram_len - src;
  const uint32_t sum = hash_bytes(ram, ram_len, (size_t)src, (size_t)bytes);
  Texture *image = NULL;
  for (int i = 0; i < bg_cache_n; i++) {
    const BgEntry *e = &bg_cache[i];
    if (e->src == (uint32_t)src && e->width == (uint32_t)width && e->height == (uint32_t)height && e->fmt == (uint32_t)fmt && e->siz == (uint32_t)siz && e->sum == sum) {
      image = e->tex;
      break;
    }
  }
  if (!image) {
    image = new_texture((uint32_t)width, (uint32_t)height);
    GfxTextureSource s = { fmt, siz, width, height, (int32_t)row_bytes, ram, ram_len, (size_t)src, NULL, 0, 0, 0 };
    gfx_decode_texture(&s, image->rgba);
    if (bg_cache_n >= BG_CACHE_ENTRIES) clear_bg_cache();
    bg_cache[bg_cache_n++] = (BgEntry){ (uint32_t)src, (uint32_t)width, (uint32_t)height, (uint32_t)fmt, (uint32_t)siz, sum, image };
  }
  finish_batch();
  const uint32_t state = take_snapshot(0);
  GfxState *s = &out_states.v[state];
  s->tiles[0] = new_tile();
  s->tiles[0].fmt = fmt;
  s->tiles[0].siz = siz;
  s->tiles[0].line = (int32_t)((row_bytes + 7) / 8);
  s->texture_ref[0] = texture_ref(image);
  s->texture_ref_tile[0] = 0;
  s->texture_ref[1] = -1;
  invalidate();
  // The copy-mode rectangle includes its last pixel and steps four pixels per texel step; the one-cycle one does not.
  const int copy = op == OP_BG_COPY;
  const int32_t step_s = copy ? 1024 : (int32_t)floor(1048576.0 / (double)(rd_u16(at + 28) > 1 ? rd_u16(at + 28) : 1) + 0.5);
  const int32_t step_t = copy ? 1024 : (int32_t)floor(1048576.0 / (double)(rd_u16(at + 30) > 1 ? rd_u16(at + 30) : 1) + 0.5);
  push_rect_batch(GFX_BATCH_TEXRECT, state, frame_x + frame_w - (copy ? 4 : 0), frame_y + frame_h - (copy ? 4 : 0), frame_x, frame_y, 0,
    image_x, image_y, copy ? 4096 : step_s, step_t);
}

// ---- Texture loading ----------------------------------------------------------------------------------------------

static void set_tile(uint32_t w0, uint32_t w1) {
  GfxTile *t = &st.tiles[(w1 >> 24) & 7];
  t->fmt = (int32_t)((w0 >> 21) & 7);
  t->siz = (int32_t)((w0 >> 19) & 3);
  t->line = (int32_t)((w0 >> 9) & 0x1ff);
  t->tmem = (int32_t)(w0 & 0x1ff);
  t->palette = (int32_t)((w1 >> 20) & 15);
  t->cm_t = (int32_t)((w1 >> 18) & 3);
  t->mask_t = (int32_t)((w1 >> 14) & 15);
  t->shift_t = (int32_t)((w1 >> 10) & 15);
  t->cm_s = (int32_t)((w1 >> 8) & 3);
  t->mask_s = (int32_t)((w1 >> 4) & 15);
  t->shift_s = (int32_t)(w1 & 15);
  invalidate();
}

static void set_tile_size(uint32_t w0, uint32_t w1) {
  GfxTile *t = &st.tiles[(w1 >> 24) & 7];
  t->uls = (int32_t)((w0 >> 12) & 0xfff);
  t->ult = (int32_t)(w0 & 0xfff);
  t->lrs = (int32_t)((w1 >> 12) & 0xfff);
  t->lrt = (int32_t)(w1 & 0xfff);
  t->sized = 1;
  invalidate();
}

// The tile's TMEM rows are filled in stream order; a block is the contiguous bytes of the image from the first texel.
static void load_block(uint32_t w0, uint32_t w1) {
  const GfxTile *t = &st.tiles[(w1 >> 24) & 7];
  const int64_t uls = (w0 >> 12) & 0xfff, ult = w0 & 0xfff, lrs = (w1 >> 12) & 0xfff;
  const int64_t src = (int64_t)timg.addr + row_bytes_of(ult * timg.width + uls, timg.siz);
  store((int64_t)t->tmem * 8, src, row_bytes_of(lrs - uls + 1, timg.siz));
}

static void load_tile(uint32_t w0, uint32_t w1) {
  const GfxTile *t = &st.tiles[(w1 >> 24) & 7];
  const int64_t uls = (int64_t)((w0 >> 12) & 0xfff) >> 2, ult = (int64_t)(w0 & 0xfff) >> 2;
  const int64_t lrs = (int64_t)((w1 >> 12) & 0xfff) >> 2, lrt = (int64_t)(w1 & 0xfff) >> 2;
  const int64_t img_row = row_bytes_of(timg.width, timg.siz);
  const int64_t bytes = row_bytes_of(lrs - uls + 1, timg.siz);
  const int64_t stride = (int64_t)t->line * (t->siz == GFX_SIZ_32 ? 16 : 8);
  for (int64_t y = 0; y <= lrt - ult; y++) {
    store((int64_t)t->tmem * 8 + y * stride, (int64_t)timg.addr + (ult + y) * img_row + row_bytes_of(uls, timg.siz), bytes);
  }
}

// The palette is stored as 16-bit entries from the tile's TMEM address.
static void load_tlut(uint32_t w1) {
  const GfxTile *t = &st.tiles[(w1 >> 24) & 7];
  const int64_t count = (((w1 >> 12) & 0xfff) >> 2) + 1;
  store((int64_t)t->tmem * 8, timg.addr, count * 2);
}

static void set_other_mode(int high, uint32_t w0, uint32_t w1) {
  const uint32_t len = (w0 & 0xff) + 1;
  const int32_t shift = 32 - (int32_t)((w0 >> 8) & 0xff) - (int32_t)len;
  const uint32_t mask = len == 32 ? 0xffffffffu : ((1u << len) - 1u) << (shift & 31);
  if (high) st.other_h = (st.other_h & ~mask) | (w1 & mask);
  else st.other_l = (st.other_l & ~mask) | (w1 & mask);
  invalidate();
}

// ---- Commands -----------------------------------------------------------------------------------------------------

static void set_color4(int32_t *c, uint32_t w) {
  c[0] = (int32_t)((w >> 24) & 255);
  c[1] = (int32_t)((w >> 16) & 255);
  c[2] = (int32_t)((w >> 8) & 255);
  c[3] = (int32_t)(w & 255);
}

static void move_word(uint32_t w0, uint32_t w1) {
  const uint32_t index = (w0 >> 16) & 0xff;
  switch (index) {
    case MW_SEGMENT: seg[((w0 & 0xffff) >> 2) & 15] = w1 & 0xffffff; break;
    case MW_NUMLIGHT: num_lights = (int)js_min(7, w1 / 24.0); break;
    case MW_FOG:
      fog_multiplier = (int32_t)w1 >> 16;
      fog_offset = (int16_t)(w1 & 0xffff);
      invalidate();
      break;
    case MW_CLIP:
    case MW_PERSPNORM:
      break;
    default:
      problem("moveword of unknown index 0x%x", index);
  }
}

static void move_mem(uint32_t w0, uint32_t w1) {
  const uint32_t index = w0 & 0xff;
  const uint32_t size = ((((w0 >> 16) & 0xff) >> 3) + 1) * 8;
  const uint32_t offset = ((w0 >> 8) & 0xff) * 8;
  const int64_t addr = address(w1);
  if (addr < 0) return;
  if (index == MM_VIEWPORT) {
    for (int k = 0; k < 3; k++) {
      st.viewport[k] = rd_s16((size_t)addr + (size_t)k * 2);
      st.viewport[3 + k] = rd_s16((size_t)addr + (size_t)(4 + k) * 2);
    }
    invalidate();
  } else if (index == MM_LIGHT) {
    if (offset % 24 != 0 || offset / 24 >= LIGHT_SLOTS || size > 16) {
      problem("light load at offset %u of %u bytes", offset, size);
      return;
    }
    uint8_t *slot = light_slots[offset / 24];
    for (size_t i = 0; i < 16 && (size_t)addr + i < ram_len; i++) slot[i] = ram[(size_t)addr + i];
  } else problem("movemem to unknown target 0x%x", index);
}

// Executes a command other than the control-flow ones; 0 when the opcode is not a known command.
static int execute(uint32_t op, uint32_t w0, uint32_t w1) {
  switch (op) {
    case OP_VTX: load_vertices(w0, w1); break;
    case OP_TRI1: triangle((w0 >> 16) & 255, (w0 >> 8) & 255, w0 & 255); break;
    case OP_TRI2:
    case OP_QUAD:
      // A quad is drawn as the two triangles of the same encoding.
      triangle((w0 >> 16) & 255, (w0 >> 8) & 255, w0 & 255);
      triangle((w1 >> 16) & 255, (w1 >> 8) & 255, w1 & 255);
      break;
    case OP_MODIFYVTX: modify_vertex(w0, w1); break;
    case OP_TEXTURE:
      st.texture_on = (w0 & 0xff) != 0;
      st.texture_level = (int32_t)((w0 >> 11) & 7);
      st.texture_tile = (int32_t)((w0 >> 8) & 7);
      st.texture_scale_s = w1 >> 16;
      st.texture_scale_t = w1 & 0xffff;
      invalidate();
      break;
    case OP_POPMTX: pop_matrix(w1); break;
    case OP_GEOMETRYMODE:
      st.geometry_mode = (st.geometry_mode & w0 & 0xffffff) | w1;
      invalidate();
      break;
    case OP_MTX: load_matrix(w0, w1, command_at); break;
    case OP_MOVEWORD: move_word(w0, w1); break;
    case OP_MOVEMEM: move_mem(w0, w1); break;
    case OP_RDPHALF_1: rdp_half1 = w1; break;
    case OP_LOAD_UCODE: ucode_2d = has_signature(rdp_half1, S2DEX_SIGNATURE); break;
    case OP_BG_1CYC:
    case OP_BG_COPY:
      if (!ucode_2d) return 0;
      background(op, w1);
      break;
    case OP_RDPHALF_2: problem("stray rdp half-word 0x%x", op); break;
    case OP_SETOTHERMODE_L: set_other_mode(0, w0, w1); break;
    case OP_SETOTHERMODE_H: set_other_mode(1, w0, w1); break;
    case OP_RDPLOADSYNC:
    case OP_RDPPIPESYNC:
    case OP_RDPTILESYNC:
    case OP_RDPFULLSYNC:
      break;
    case OP_SETSCISSOR:
      st.scissor[0] = (int32_t)((w1 >> 24) & 3);
      st.scissor[1] = (int32_t)((w0 >> 12) & 0xfff);
      st.scissor[2] = (int32_t)(w0 & 0xfff);
      st.scissor[3] = (int32_t)((w1 >> 12) & 0xfff);
      st.scissor[4] = (int32_t)(w1 & 0xfff);
      invalidate();
      break;
    case OP_SETOTHERMODE:
      st.other_h = (st.other_h & 0xff000000u) | (w0 & 0xffffff);
      st.other_l = w1;
      invalidate();
      break;
    case OP_LOADTLUT: load_tlut(w1); break;
    case OP_SETTILESIZE: set_tile_size(w0, w1); break;
    case OP_LOADBLOCK: load_block(w0, w1); break;
    case OP_LOADTILE: load_tile(w0, w1); break;
    case OP_SETTILE: set_tile(w0, w1); break;
    case OP_FILLRECT: fill_rect(w0, w1); break;
    case OP_SETFILLCOLOR: st.fill_color = w1; invalidate(); break;
    case OP_SETFOGCOLOR: set_color4(st.fog_color, w1); invalidate(); break;
    case OP_SETBLENDCOLOR: set_color4(st.blend_color, w1); invalidate(); break;
    case OP_SETPRIMCOLOR:
      set_color4(st.prim_color, w1);
      st.prim_color[4] = (int32_t)((w0 >> 8) & 31);
      st.prim_color[5] = (int32_t)(w0 & 255);
      invalidate();
      break;
    case OP_SETENVCOLOR: set_color4(st.env_color, w1); invalidate(); break;
    case OP_SETCOMBINE:
      st.combine_raw[0] = w0 & 0xffffff;
      st.combine_raw[1] = w1;
      invalidate();
      break;
    case OP_SETTIMG: {
      const int64_t addr = address(w1);
      timg.fmt = (int32_t)((w0 >> 21) & 7);
      timg.siz = (int32_t)((w0 >> 19) & 3);
      timg.width = (int32_t)(w0 & 0xfff) + 1;
      timg.addr = (uint32_t)at_least_zero(addr);
      break;
    }
    case OP_SETZIMG: st.depth_image = (uint32_t)at_least_zero(address(w1)); invalidate(); break;
    case OP_SETCIMG:
      st.color_image[0] = (int32_t)((w0 >> 21) & 7);
      st.color_image[1] = (int32_t)((w0 >> 19) & 3);
      st.color_image[2] = (int32_t)(w0 & 0xfff) + 1;
      st.color_image[3] = (int32_t)at_least_zero(address(w1));
      invalidate();
      break;
    default:
      return 0;
  }
  return 1;
}

static void reset(void) {
  memset(seg, 0, sizeof seg);
  identity(mv);
  identity(proj);
  mv_stack.n = 0;
  mvp_valid = 0;
  memset(vert_loaded, 0, sizeof vert_loaded);
  memset(tmem, 0, sizeof tmem);
  tmem_epoch++;
  memset(&st, 0, sizeof st);
  for (int i = 0; i < 8; i++) st.tiles[i] = new_tile();
  st.texture_ref[0] = st.texture_ref[1] = -1;
  timg.fmt = 0;
  timg.siz = 0;
  timg.width = 1;
  timg.addr = 0;
  fog_multiplier = fog_offset = 0;
  num_lights = 0;
  memset(light_slots, 0, sizeof light_slots);
  snapshot_valid = 0;
  rdp_half1 = 0;
  ucode_2d = 0;
  batch_open = 0;
  batch_first = 0;
  out_pos.n = out_col.n = out_uv.n = 0;
  out_batches.n = out_states.n = out_textures.n = out_unknown.n = out_opcodes.n = 0;
  out_problem_count = 0;
  memset(opcode_counts, 0, sizeof opcode_counts);
  commands = 0;
  free_retired();
  run_stamp++;
  context.hash = 0;
  context.entry = -1;
  matrix_record.n = vertex_load_record.n = 0;
}

static void count_opcode(uint32_t op) {
  if (opcode_counts[op]++ == 0) VEC_PUSH(out_opcodes, op);
}

uint32_t gfx_run_ram(const uint8_t *image, uint32_t size, uint32_t start, uint32_t max_commands) {
  ram = image;
  ram_len = size;
  reset();
  uint32_t stack[MAX_DL_DEPTH];
  ListContext context_stack[MAX_DL_DEPTH];
  int depth = 0;
  int64_t pc = address(start);
  int running = pc >= 0;
  while (running && commands < max_commands) {
    if ((size_t)pc + 8 > ram_len) {
      problem("list runs off memory at 0x%x", (uint32_t)pc);
      break;
    }
    const uint32_t w0 = rd_u32((size_t)pc);
    const uint32_t w1 = rd_u32((size_t)pc + 4);
    const uint32_t op = w0 >> 24;
    const uint32_t at = (uint32_t)pc;
    command_at = at;
    pc += 8;
    commands++;
    count_opcode(op);
    switch (op) {
      case OP_DL: {
        const int64_t target = address(w1);
        if (target < 0) break;
        if ((w0 >> 16) & 1) {
          context = enter_list(w1, target);
          pc = target;
        } else if (depth >= MAX_DL_DEPTH) problem("display list nesting too deep");
        else {
          stack[depth] = (uint32_t)pc;
          context_stack[depth++] = context;
          context = enter_list(w1, target);
          pc = target;
        }
        break;
      }
      case OP_ENDDL:
        if (depth == 0) running = 0;
        else {
          context = context_stack[--depth];
          pc = stack[depth];
        }
        break;
      case OP_CULLDL:
        if (cull_list(w0, w1)) {
          if (depth == 0) running = 0;
          else {
            context = context_stack[--depth];
            pc = stack[depth];
          }
        }
        break;
      case OP_BRANCH_Z: {
        // Branch (without return) to the address of the last RDPHALF_1 when the vertex's w, the distance from the eye, is
        // below the command's value; the comparison is of the integer part of w.
        const Vertex *v = NULL;
        const uint32_t slot = w0 & 0xfff;
        const int loaded = slot_of(slot, &v);
        const int64_t target = address(rdp_half1);
        if (loaded && target >= 0 && floor(v->clip[3]) < (double)(int32_t)w1) {
          context = enter_list(rdp_half1, target);
          pc = target;
        }
        break;
      }
      case OP_TEXRECT: {
        const uint32_t h1 = (size_t)pc + 8 <= ram_len ? rd_u32((size_t)pc) >> 24 : 0;
        const uint32_t h2 = (size_t)pc + 16 <= ram_len ? rd_u32((size_t)pc + 8) >> 24 : 0;
        if (h1 == OP_RDPHALF_1 && h2 == OP_RDPHALF_2) {
          tex_rect(w0, w1, rd_u32((size_t)pc + 4), rd_u32((size_t)pc + 12));
          commands += 2;
          count_opcode(h1);
          count_opcode(h2);
          pc += 16;
        } else problem("texture rectangle at 0x%x is not followed by its two half-words", at);
        break;
      }
      default:
        if (!execute(op, w0, w1)) {
          GfxUnknown u = { at, w0, w1 };
          VEC_PUSH(out_unknown, u);
        }
    }
  }
  finish_batch();
  return commands;
}

const GfxResult *gfx_result(void) {
  result.commands = commands;
  result.batch_count = (uint32_t)out_batches.n;
  result.batches = out_batches.v;
  result.state_count = (uint32_t)out_states.n;
  result.states = out_states.v;
  result.texture_count = (uint32_t)out_textures.n;
  result.textures = out_textures.v;
  result.vertex_count = (uint32_t)(out_pos.n / 4);
  result.positions = out_pos.v;
  result.colors = out_col.v;
  result.uvs = out_uv.v;
  result.problem_count = out_problem_count;
  result.problems = &out_problems[0][0];
  result.unknown_count = (uint32_t)out_unknown.n;
  result.unknown = out_unknown.v;
  // Opcode counts are stored apart from their order: expand into pairs on demand.
  static VEC(uint32_t) pairs;
  pairs.n = 0;
  for (size_t i = 0; i < out_opcodes.n; i++) {
    VEC_PUSH(pairs, out_opcodes.v[i]);
    VEC_PUSH(pairs, opcode_counts[out_opcodes.v[i]]);
  }
  result.opcode_count = (uint32_t)out_opcodes.n;
  result.opcodes = pairs.v;
  return &result;
}

void gfx_trace_vertices(uint32_t on) {
  vertex_trace.n = 0;
  vertex_trace_on = on != 0;
}
const double *gfx_vertex_trace(void) { return vertex_trace.v; }
uint32_t gfx_vertex_trace_length(void) { return (uint32_t)vertex_trace.n; }

void gfx_reset(void) {
  VEC_FREE(vertex_trace);
  vertex_trace_on = 0;
  reset();
  clear_tile_cache();
  clear_bg_cache();
  free_retired();
  VEC_FREE(out_pos);
  VEC_FREE(out_col);
  VEC_FREE(out_uv);
  VEC_FREE(out_batches);
  VEC_FREE(out_states);
  VEC_FREE(out_textures);
  VEC_FREE(out_unknown);
  VEC_FREE(out_opcodes);
  VEC_FREE(mv_stack);
  VEC_FREE(matrix_record);
  VEC_FREE(vertex_load_record);
  VEC_FREE(override_input);
  free(override_table);
  override_table = NULL;
  override_slots = 0;
  motion_record = 0;
  ram = NULL;
  ram_len = 0;
}

// Sizes of the records of the result in 32-bit words (0 result, 1 batch, 2 state, 3 texture reference, 4 unknown command,
// 6 matrix record, 7 vertex load record) and the bytes of a problem string (5); readers check their layout against these.
uint32_t gfx_layout(uint32_t what) {
  switch (what) {
    case 0: return sizeof(GfxResult) / 4;
    case 1: return sizeof(GfxBatch) / 4;
    case 2: return sizeof(GfxState) / 4;
    case 3: return sizeof(GfxTextureRef) / 4;
    case 4: return sizeof(GfxUnknown) / 4;
    case 5: return GFX_PROBLEM_BYTES;
    case 6: return sizeof(GfxMatrix) / 4;
    case 7: return sizeof(GfxVertexLoad) / 4;
    default: return 0;
  }
}
