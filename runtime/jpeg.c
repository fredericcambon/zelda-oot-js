// The JPEG decode task: the microcode at 0x800e4b10 turns blocks of Huffman-decoded coefficients into RGBA5551 pixels.
// It is not executed; this does what its code does, read from its instructions (data in RSP memory 0x000-0x01f is the
// microcode's own constant table, copied from 0x80112b70).
// - Task data (task->data_ptr, 0x20 bytes, built at 0x8005b6e0-0x8005b73c; the microcode reads it into RSP memory
//   0x1e0 at 0x038-0x044): +0 physical address of the macroblocks, +4 their count (word at 0x1e4, loaded into v1 at
//   0x0b0 and decremented per macroblock at 0x0ec), +8 the mode (bgtz at 0x08c: above zero selects 768-byte
//   macroblocks of six blocks, the DMA lengths 0x2ff and 0x1ff at 0x0a4-0x0ac), +0xc/+0x10/+0x14 physical addresses
//   of three 64-halfword quantisation tables, loaded to RSP memory 0x60, 0xe0 and 0x160 at 0x054-0x080.
// - A block is 64 signed halfwords in zigzag order (the Huffman routine 0x800cf818 stores coefficient n at index n);
//   a quantisation table is 64 unsigned halfwords in the same order (0x800cf0e0 copies the stream bytes unchanged).
// - Per macroblock the microcode multiplies each coefficient by its table entry (vmudh, 0x154-0x18c), scatters the
//   results to natural order (ssv, 0x23c-0x338), runs two passes of an 8-point inverse DCT with the cosine constants
//   of RSP memory 0x10-0x4f (vmulf/vmacf, 0x39c-0x554), then converts YCbCr to RGB (0x588-0x75c): Y plus 0x800,
//   R = Y + Cr * (1 + 0x670a/65536), G = Y - Cb * 0x5824/65536 - Cr * 0xb6e3/65536, B = Y + Cb * (1 + 0xc5e3/65536),
//   each clamped to 0..0xff0 (the samples carry four fractional bits), shifted right by 7 into five bits and packed
//   as R << 11 | G << 6 | B << 1 | 1 (multipliers 0x800, 0x40, 0x2 and the OR with 1 from RSP memory 0x06-0x0d).
// - The six blocks are four luma blocks (top-left, top-right, bottom-left, bottom-right), then Cb, then Cr; each chroma
//   sample covers 2x2 pixels. The 16x16 result is written over the start of the macroblock, 32 bytes per row (the
//   consumer at 0x8005b81c reads it that way).
#include <math.h>
#include "rt.h"

#define BLOCK_BYTES 128
#define MACROBLOCK_BYTES (6 * BLOCK_BYTES)

static const uint8_t zigzag[64] = {
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
};

// Samples of one block (Y level-shifted to 0..255 scale, chroma centred on zero), dequantised and transformed.
static void decode_block(uint32_t block, uint32_t qtable, float out[64]) {
  static float basis[8][8];
  static int ready;
  if (!ready) {
    for (int x = 0; x < 8; x++)
      for (int u = 0; u < 8; u++) basis[x][u] = (u == 0 ? sqrtf(0.125f) : 0.5f) * cosf((2 * x + 1) * u * 3.14159265358979f / 16);
    ready = 1;
  }
  float coef[64] = {0};
  for (int n = 0; n < 64; n++) coef[zigzag[n]] = (float)(int16_t)rd16(block + 2 * n) * (float)rd16(qtable + 2 * n);
  float tmp[64];
  for (int v = 0; v < 8; v++)
    for (int x = 0; x < 8; x++) {
      float s = 0;
      for (int u = 0; u < 8; u++) s += basis[x][u] * coef[v * 8 + u];
      tmp[v * 8 + x] = s;
    }
  for (int y = 0; y < 8; y++)
    for (int x = 0; x < 8; x++) {
      float s = 0;
      for (int v = 0; v < 8; v++) s += basis[y][v] * tmp[v * 8 + x];
      out[y * 8 + x] = s;
    }
}

static uint32_t sample5(float v) {
  int s = (int)lrintf(v * 16.0f);
  if (s < 0) s = 0;
  if (s > 0xff0) s = 0xff0;
  return (uint32_t)s >> 7;
}

static uint32_t tasks_done;
uint32_t rt_jpeg_tasks(void) { return tasks_done; }

void rt_jpeg_task(const RspTask *task) {
  tasks_done++;
  uint32_t d = task->data_ptr;
  uint32_t address = rd32(d + 0), count = rd32(d + 4), mode = rd32(d + 8);
  uint32_t q[3] = {rd32(d + 0xc), rd32(d + 0x10), rd32(d + 0x14)};
  if ((int32_t)mode <= 0) rt_fatal("JPEG task in mode %d: only the six-block macroblock (mode above zero) is implemented", (int)mode);
  for (uint32_t m = 0; m < count; m++) {
    uint32_t mb = address + m * MACROBLOCK_BYTES;
    float y[4][64], cb[64], cr[64];
    for (int b = 0; b < 4; b++) decode_block(mb + b * BLOCK_BYTES, q[0], y[b]);
    decode_block(mb + 4 * BLOCK_BYTES, q[1], cb);
    decode_block(mb + 5 * BLOCK_BYTES, q[2], cr);
    uint16_t pixels[256];
    for (int py = 0; py < 16; py++)
      for (int px = 0; px < 16; px++) {
        float luma = y[(py >> 3) * 2 + (px >> 3)][(py & 7) * 8 + (px & 7)] + 128.0f;
        float u = cb[(py >> 1) * 8 + (px >> 1)], v = cr[(py >> 1) * 8 + (px >> 1)];
        float r = luma + v * (1.0f + 26378.0f / 65536.0f);
        float g = luma - u * (22564.0f / 65536.0f) - v * (46819.0f / 65536.0f);
        float b = luma + u * (1.0f + 50659.0f / 65536.0f);
        pixels[py * 16 + px] = (uint16_t)(sample5(r) << 11 | sample5(g) << 6 | sample5(b) << 1 | 1);
      }
    for (int i = 0; i < 256; i++) wr16(mb + 2 * i, pixels[i]);
  }
}

int jpeg_save(Writer *w) {
  put32(w, tasks_done);
  return 1;
}

int jpeg_load(Reader *r, int apply) {
  uint32_t n = get32(r);
  if (r->bad) return rt_state_refuse("the JPEG decoder state is damaged");
  if (apply) tasks_done = n;
  return 1;
}
