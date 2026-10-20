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
  // For each of those images: the colour image a game drawn into earlier (this task or before) that its texels were loaded
  // from, as the address of that image, then the column and row of the image's first texel in it; address -1 when the
  // texels come from memory the RDP has not drawn into (or that changed since).
  int32_t texture_source[2][3];
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
// RGBA8, top row first. `loaded` is NULL when every texel was written by the load commands that fed the tile, else one
// byte per texel (1 = written by them, 0 = left over from earlier loads); the image is the tile's sampled rectangle (from
// SetTileSize, else the mask). `fmt` and `siz` are those of the tile it was decoded for.
typedef struct {
  uint32_t id, width, height;
  const uint8_t *rgba;
  const uint8_t *loaded;
  int32_t fmt, siz;
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
// Records the vertices of every vertex load of the runs that follow (on != 0; clears the record). The record is a sequence of
// (w0, first slot, count) followed by count vertices of ten doubles: clip x y z w, colour r g b a, s, t.
void gfx_trace_vertices(uint32_t on);
const double *gfx_vertex_trace(void);
uint32_t gfx_vertex_trace_length(void);

// ---- Per-pixel lighting (dl.c) --------------------------------------------------------------------------------

// What a renderer needs to shade lit vertices per pixel; `gfx_set_pixel_lighting` turns the output below on (it is empty while off).
// The formula is the one the interpreter lights vertices with (docs/re/display-lists.md section 9), applied to the normal bytes
// interpolated across the triangle in place of the colour.
enum { GFX_MAX_LIGHTS = 7, GFX_LIGHTS_OFF = 0, GFX_LIGHTS_PIXEL = 1, GFX_LIGHTS_PIXEL_ALL = 2 };

// The lights in force for a run of lit vertices. Directions are the light vectors in the vertices' model space as
// `model_direction` leaves them (whole numbers in -128..127, not of unit length), colours are bytes (0..255).
typedef struct {
  uint32_t count;
  float ambient[3];
  float color[GFX_MAX_LIGHTS][3];
  float dir[GFX_MAX_LIGHTS][3];
} GfxLightSet;

typedef struct {
  // 1 when the run was made with pixel lighting on (the arrays below are meaningful), else 0.
  uint32_t enabled;
  // Per vertex of the triangle batches (same indices as the positions): the normal bytes (x, y, z) and 1 where the vertex belongs to a
  // triangle to light per pixel, else 0 (unlit, reversed normals, or vertices of different light sets).
  const float *normals;
  uint32_t light_set_count;
  const GfxLightSet *light_sets;
  // Per batch (same indices as the batches): 1 + the index of its light set, 0 for none.
  const uint32_t *batch_light_sets;
  // Triangles drawn from lit vertices; the ones among them whose normals disagree with their face (cosine below -0.5 between the
  // sum of the vertex normals and the face normal from the model-space positions); the ones whose vertices were lit with different
  // light sets or not all lit (skinned joints, where the vertices come from different matrices); and the ones left on the vertex path.
  uint32_t lit_triangles, reversed_triangles, mixed_triangles, vertex_path_triangles;
} GfxLightResult;

// Sets what the runs that follow produce: GFX_LIGHTS_OFF, GFX_LIGHTS_PIXEL (triangles with reversed normals stay on the vertex
// path) or GFX_LIGHTS_PIXEL_ALL (they are lit per pixel too).
void gfx_set_pixel_lighting(uint32_t mode);
const GfxLightResult *gfx_light_result(void);

// ---- Camera output (dl.c) -------------------------------------------------------------------------------------

// While `gfx_set_camera_output` is on, the per-vertex normal words (the array of GfxLightResult) are produced even without pixel
// lighting, and their fourth value is (1 for a triangle lit per pixel) + 2 * (1 + the slot below of the perspective projection the
// triangle's vertices were transformed under; 0 for an orthographic one). The view matrix is multiplied into the projection, so a
// slot's matrix takes a world position (row vector, w = 1) to the clip space of the vertex data.
enum { GFX_MAX_CAMERAS = 3 };

typedef struct {
  uint32_t count;
  uint32_t vertices[GFX_MAX_CAMERAS];
  // Sixteen values per slot, row-major for row vectors.
  double matrix[GFX_MAX_CAMERAS][16];
} GfxCameraResult;

void gfx_set_camera_output(uint32_t on);
const GfxCameraResult *gfx_camera_result(void);

// ---- Motion: matrix names, records and overrides (dl.c) -----------------------------------------------------------

enum {
  GFX_MTX_PROJECTION = 1, GFX_MTX_LOAD = 2, GFX_MTX_PUSH = 4,
  // The projection in force when the matrix was loaded (or the matrix itself, for a projection) is a perspective one.
  GFX_MTX_PERSPECTIVE = 8,
  // Marks a filled slot of the override table; never set in a record.
  GFX_MTX_PRESENT = 0x80000000u,
};

// A matrix as a command loads it. The name is 53 bits wide (name_hi holds the upper 21), so that JS holds it exactly in a number.
// The name says where in the display lists the command is, the same from frame to frame; the ordinal counts the commands of
// that name in the run, so that name and ordinal together are unique within a run. See "Matrix identity" in dl.c.
typedef struct {
  uint32_t name_lo, name_hi;
  uint32_t flags;
  uint32_t ordinal;
  // Physical address the matrix was read from.
  uint32_t source;
  uint32_t reserved;
  // Sixteen values in the order the command stores them (row-major, for row vectors), the fixed-point parts joined.
  double m[16];
} GfxMatrix;

// A vertex load: a hash of the vertex bytes and the number of vertices.
typedef struct {
  uint32_t hash, count;
} GfxVertexLoad;

// While on, the runs that follow record every matrix command and vertex load (the record of the previous run is dropped).
void gfx_motion_record(uint32_t on);
uint32_t gfx_motion_count(void);
const GfxMatrix *gfx_motion_matrices(void);
uint32_t gfx_motion_vertex_load_count(void);
const GfxVertexLoad *gfx_motion_vertex_loads(void);
GfxMatrix *gfx_motion_input(uint32_t n);
void gfx_motion_commit(uint32_t n);

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
