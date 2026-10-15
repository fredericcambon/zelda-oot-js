// Stub runtime: just enough for the recompiled code to link. It reports every service the game would
// need instead of providing it, and implements the indirect-call dispatch over the generated tables.
#include <stdio.h>
#include <stdlib.h>
#include "dispatch.h"

uint8_t rdram[RDRAM_SIZE];

static const ImageInfo *find_image(uint32_t addr, uint32_t *link_addr) {
  for (uint32_t k = 0; k < oot_image_count; k++) {
    const ImageInfo *im = &oot_images[k];
    if (!im->loaded) continue;
    uint32_t a = addr - im->delta;
    if (a >= im->link_start && a < im->link_end) {
      *link_addr = a;
      return im;
    }
  }
  return NULL;
}

GuestFn oot_lookup(uint32_t addr) {
  uint32_t a;
  const ImageInfo *im = find_image(addr, &a);
  if (!im) return NULL;
  uint32_t lo = 0, hi = im->count;
  while (lo < hi) {
    uint32_t mid = (lo + hi) / 2;
    if (im->table[mid].addr < a) lo = mid + 1;
    else hi = mid;
  }
  return lo < im->count && im->table[lo].addr == a ? im->table[lo].fn : NULL;
}

void rt_call(Cpu *c, uint32_t addr) {
  GuestFn fn = oot_lookup(addr);
  if (!fn) rt_missing(c, addr);
  fn(c);
}

__attribute__((noreturn)) void rt_missing(Cpu *c, uint32_t addr) {
  (void)c;
  fprintf(stderr, "missing function at 0x%08x\n", addr);
  abort();
}

__attribute__((noreturn)) void rt_trap(Cpu *c, int kind, uint32_t pc, uint32_t code) {
  (void)c;
  fprintf(stderr, "exception %d at 0x%08x (code %u)\n", kind, pc, code);
  abort();
}

__attribute__((noreturn)) void rt_unimpl(Cpu *c, uint32_t pc, uint32_t word) {
  (void)c;
  fprintf(stderr, "untranslated instruction 0x%08x at 0x%08x\n", word, pc);
  abort();
}

static uint64_t cop0[32];

uint64_t rt_mfc0(Cpu *c, uint32_t reg) { (void)c; return cop0[reg & 31]; }
void rt_mtc0(Cpu *c, uint32_t reg, uint64_t value) { (void)c; cop0[reg & 31] = value; }
void rt_tlb(Cpu *c, int op, uint32_t pc) { (void)c; (void)op; (void)pc; }
void rt_cache(Cpu *c, uint32_t op, uint32_t addr) { (void)c; (void)op; (void)addr; }

__attribute__((noreturn)) void rt_eret(Cpu *c) {
  (void)c;
  fprintf(stderr, "eret outside an exception\n");
  abort();
}

int main(void) {
  Cpu cpu;
  memset(&cpu, 0, sizeof cpu);
  cpu.fr = 1;
  fprintf(stderr, "stub runtime: nothing to run yet\n");
  return 0;
}
