// CPU context and primitives shared by all recompiled MIPS code.
#ifndef OOT_CPU_H
#define OOT_CPU_H

#include <stdint.h>
#include <string.h>

typedef struct Cpu {
  uint64_t r[32];
  uint64_t hi, lo;
  uint32_t llbit;
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
// Indirect call through the runtime's table of recompiled functions.
void rt_call(Cpu *c, uint32_t addr);

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

#endif
