// CPU context and primitives shared by all recompiled MIPS code.
#ifndef OOT_CPU_H
#define OOT_CPU_H

#include <math.h>
#include <stdint.h>
#include <string.h>

typedef struct Cpu {
  uint64_t r[32];
  uint64_t hi, lo;
  uint32_t llbit;
  // COP1. Registers hold raw bits. With fr == 1 each of the 32 registers is a full 64-bit register; with
  // fr == 0 an odd register is the upper half of the even register before it and doubles use even registers.
  uint64_t f[32];
  uint32_t fcsr;
  uint32_t fir;
  uint32_t fr;
} Cpu;

enum TrapKind {
  TRAP_OVERFLOW = 1, // add, addi, sub, dadd, daddi, dsub
  TRAP_COND = 2,     // tge, tgeu, tlt, tltu, teq, tne and the immediate forms
  TRAP_BREAK = 3,
  TRAP_SYSCALL = 4,
};

#define RDRAM_SIZE 0x800000u

extern uint8_t rdram[RDRAM_SIZE];

// Raises a processor exception; control never returns to the recompiled code.
__attribute__((noreturn)) void rt_trap(Cpu *c, int kind, uint32_t pc, uint32_t code);
// Instruction the recompiler does not translate (FPU, COP0, ...).
__attribute__((noreturn)) void rt_unimpl(Cpu *c, uint32_t pc, uint32_t word);
// A direct transfer whose target lies in no recompiled file was reached.
__attribute__((noreturn)) void rt_missing(Cpu *c, uint32_t addr);
// Debug builds (-DOOT_TRACE) record the entry of every recompiled function in a ring that oot_trace_at reads.
#ifdef OOT_TRACE
void rt_trace_enter(uint32_t addr);
#define OOT_TRACE_ENTER(addr) rt_trace_enter(addr)
#else
#define OOT_TRACE_ENTER(addr) ((void)0)
#endif

// Indirect call through the runtime's table of recompiled functions.
void rt_call(Cpu *c, uint32_t addr);

// COP0 register access (mfc0, dmfc0, mtc0, dmtc0). Reads return the register's full value.
uint64_t rt_mfc0(Cpu *c, uint32_t reg);
void rt_mtc0(Cpu *c, uint32_t reg, uint64_t value);
enum TlbOp { TLB_READ = 1, TLB_WRITE_INDEXED = 2, TLB_WRITE_RANDOM = 3, TLB_PROBE = 4 };
void rt_tlb(Cpu *c, int op, uint32_t pc);
// Return from exception: control continues at the saved exception PC, never in the calling function.
__attribute__((noreturn)) void rt_eret(Cpu *c);
// Cache instruction `op` (the instruction's rt field) on the line containing `addr`.
void rt_cache(Cpu *c, uint32_t op, uint32_t addr);

#define SX32(x) ((uint64_t)(int64_t)(int32_t)(x))

// Guest addresses map onto RDRAM by dropping the segment bits and wrapping at its size.
static inline uint8_t *mem_ptr(uint32_t a) { return rdram + (a & (RDRAM_SIZE - 1)); }

// Guest memory is big-endian; the host is little-endian.
static inline uint8_t rd8(uint32_t a) { return *mem_ptr(a); }
static inline uint16_t rd16(uint32_t a) { uint16_t v; memcpy(&v, mem_ptr(a), 2); return __builtin_bswap16(v); }
static inline uint32_t rd32(uint32_t a) { uint32_t v; memcpy(&v, mem_ptr(a), 4); return __builtin_bswap32(v); }
static inline uint64_t rd64(uint32_t a) { uint64_t v; memcpy(&v, mem_ptr(a), 8); return __builtin_bswap64(v); }
static inline void wr8(uint32_t a, uint8_t v) { *mem_ptr(a) = v; }
static inline void wr16(uint32_t a, uint16_t v) { v = __builtin_bswap16(v); memcpy(mem_ptr(a), &v, 2); }
static inline void wr32(uint32_t a, uint32_t v) { v = __builtin_bswap32(v); memcpy(mem_ptr(a), &v, 4); }
static inline void wr64(uint32_t a, uint64_t v) { v = __builtin_bswap64(v); memcpy(mem_ptr(a), &v, 8); }

// Unaligned access: the aligned word/doubleword containing the address is merged with the register.
static inline uint64_t lwl(uint64_t rt, uint32_t a) {
  unsigned sh = (a & 3) * 8;
  uint32_t w = rd32(a & ~3u);
  return SX32((((uint32_t)rt) & ~(0xFFFFFFFFu << sh)) | (w << sh));
}
// A partial merge keeps the upper half of the register; only a full word is sign-extended.
static inline uint64_t lwr(uint64_t rt, uint32_t a) {
  unsigned sh = 24 - (a & 3) * 8;
  uint32_t w = rd32(a & ~3u);
  uint32_t m = (((uint32_t)rt) & ~(0xFFFFFFFFu >> sh)) | (w >> sh);
  return sh == 0 ? SX32(m) : (rt & 0xFFFFFFFF00000000ull) | m;
}
static inline uint64_t ldl(uint64_t rt, uint32_t a) {
  unsigned sh = (a & 7) * 8;
  uint64_t d = rd64(a & ~7u);
  return (rt & ~(~0ull << sh)) | (d << sh);
}
static inline uint64_t ldr(uint64_t rt, uint32_t a) {
  unsigned sh = 56 - (a & 7) * 8;
  uint64_t d = rd64(a & ~7u);
  return (rt & ~(~0ull >> sh)) | (d >> sh);
}
static inline void swl(uint32_t rt, uint32_t a) {
  unsigned sh = (a & 3) * 8;
  uint32_t w = rd32(a & ~3u);
  wr32(a & ~3u, (w & ~(0xFFFFFFFFu >> sh)) | (rt >> sh));
}
static inline void swr(uint32_t rt, uint32_t a) {
  unsigned sh = 24 - (a & 3) * 8;
  uint32_t w = rd32(a & ~3u);
  wr32(a & ~3u, (w & ~(0xFFFFFFFFu << sh)) | (rt << sh));
}
static inline void sdl(uint64_t rt, uint32_t a) {
  unsigned sh = (a & 7) * 8;
  uint64_t d = rd64(a & ~7u);
  wr64(a & ~7u, (d & ~(~0ull >> sh)) | (rt >> sh));
}
static inline void sdr(uint64_t rt, uint32_t a) {
  unsigned sh = 56 - (a & 7) * 8;
  uint64_t d = rd64(a & ~7u);
  wr64(a & ~7u, (d & ~(~0ull << sh)) | (rt << sh));
}

// Multiply and divide. The manual leaves division by zero unpredictable; these results are fixed
// so that recompiled code behaves deterministically. INT_MIN / -1 wraps instead of trapping.
static inline void mult32(Cpu *c, int32_t a, int32_t b) {
  int64_t p = (int64_t)a * b;
  c->lo = SX32((uint32_t)p);
  c->hi = SX32((uint32_t)((uint64_t)p >> 32));
}
static inline void multu32(Cpu *c, uint32_t a, uint32_t b) {
  uint64_t p = (uint64_t)a * b;
  c->lo = SX32((uint32_t)p);
  c->hi = SX32((uint32_t)(p >> 32));
}
static inline void div32(Cpu *c, int32_t a, int32_t b) {
  if (b == 0) { c->lo = a < 0 ? 1 : (uint64_t)-1; c->hi = SX32(a); }
  else if (a == INT32_MIN && b == -1) { c->lo = SX32(a); c->hi = 0; }
  else { c->lo = SX32(a / b); c->hi = SX32(a % b); }
}
static inline void divu32(Cpu *c, uint32_t a, uint32_t b) {
  if (b == 0) { c->lo = (uint64_t)-1; c->hi = SX32(a); }
  else { c->lo = SX32(a / b); c->hi = SX32(a % b); }
}
static inline void dmult64(Cpu *c, int64_t a, int64_t b) {
  __int128 p = (__int128)a * b;
  c->lo = (uint64_t)p;
  c->hi = (uint64_t)((unsigned __int128)p >> 64);
}
static inline void dmultu64(Cpu *c, uint64_t a, uint64_t b) {
  unsigned __int128 p = (unsigned __int128)a * b;
  c->lo = (uint64_t)p;
  c->hi = (uint64_t)(p >> 64);
}
static inline void ddiv64(Cpu *c, int64_t a, int64_t b) {
  if (b == 0) { c->lo = a < 0 ? 1 : (uint64_t)-1; c->hi = (uint64_t)a; }
  else if (a == INT64_MIN && b == -1) { c->lo = (uint64_t)a; c->hi = 0; }
  else { c->lo = (uint64_t)(a / b); c->hi = (uint64_t)(a % b); }
}
static inline void ddivu64(Cpu *c, uint64_t a, uint64_t b) {
  if (b == 0) { c->lo = (uint64_t)-1; c->hi = a; }
  else { c->lo = a / b; c->hi = a % b; }
}

// ---- COP1 -------------------------------------------------------------------------------------------

#define FCSR_COND (1u << 23)
#define FCSR_VALID 0x0183ffffu

static inline uint32_t fpr_w(const Cpu *c, int n) {
  if (c->fr) return (uint32_t)c->f[n];
  return (uint32_t)(c->f[n & ~1] >> ((n & 1) * 32));
}
static inline void set_fpr_w(Cpu *c, int n, uint32_t v) {
  if (c->fr) { c->f[n] = (c->f[n] & ~0xFFFFFFFFull) | v; return; }
  unsigned sh = (n & 1) * 32;
  c->f[n & ~1] = (c->f[n & ~1] & ~(0xFFFFFFFFull << sh)) | ((uint64_t)v << sh);
}
static inline uint64_t fpr_d(const Cpu *c, int n) { return c->f[c->fr ? n : (n & ~1)]; }
static inline void set_fpr_d(Cpu *c, int n, uint64_t v) { c->f[c->fr ? n : (n & ~1)] = v; }
static inline float fpr_s(const Cpu *c, int n) { uint32_t w = fpr_w(c, n); float x; memcpy(&x, &w, 4); return x; }
static inline void set_fpr_s(Cpu *c, int n, float x) { uint32_t w; memcpy(&w, &x, 4); set_fpr_w(c, n, w); }
static inline double fpr_dbl(const Cpu *c, int n) { uint64_t d = fpr_d(c, n); double x; memcpy(&x, &d, 8); return x; }
static inline void set_fpr_dbl(Cpu *c, int n, double x) { uint64_t d; memcpy(&d, &x, 8); set_fpr_d(c, n, d); }

static inline uint64_t cfc1(const Cpu *c, int n) { return n == 31 ? SX32(c->fcsr) : n == 0 ? SX32(c->fir) : 0; }
static inline void ctc1(Cpu *c, int n, uint32_t v) { if (n == 31) c->fcsr = v & FCSR_VALID; }

// Conversions to integer follow the rounding mode of FCSR (0 nearest even, 1 toward zero, 2 up, 3 down).
// A NaN or out-of-range operand, which the hardware reports as an unimplemented-operation exception,
// saturates to the largest value of the destination (the most negative one for large negative operands).
static inline double fp_round(double x, unsigned mode) {
  switch (mode & 3) {
    case 0: return rint(x);
    case 1: return trunc(x);
    case 2: return ceil(x);
    default: return floor(x);
  }
}
static inline uint32_t fp_to_w(double x, unsigned mode) {
  if (x != x) return 0x7FFFFFFFu;
  double r = fp_round(x, mode);
  if (r >= 2147483648.0) return 0x7FFFFFFFu;
  if (r < -2147483648.0) return 0x80000000u;
  return (uint32_t)(int32_t)r;
}
static inline uint64_t fp_to_l(double x, unsigned mode) {
  if (x != x) return 0x7FFFFFFFFFFFFFFFull;
  double r = fp_round(x, mode);
  if (r >= 9223372036854775808.0) return 0x7FFFFFFFFFFFFFFFull;
  if (r < -9223372036854775808.0) return 0x8000000000000000ull;
  return (uint64_t)(int64_t)r;
}
#define FP_MODE(c) ((c)->fcsr & 3u)

// Compare: bit 0 of `cond` selects "true when unordered", bit 1 "true when equal", bit 2 "true when less".
// Bit 3 (signal on NaN) only matters for the invalid-operation exception, which is not raised.
static inline void fp_cmp(Cpu *c, unsigned cond, int unordered, int less, int equal) {
  int t = ((cond & 1) && unordered) || ((cond & 2) && equal) || ((cond & 4) && less);
  c->fcsr = (c->fcsr & ~FCSR_COND) | (t ? FCSR_COND : 0);
}
#define FP_COND(c) (((c)->fcsr & FCSR_COND) != 0)

#endif
