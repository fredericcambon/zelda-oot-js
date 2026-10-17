// Guest memory, indirect-call dispatch over the generated tables, the overlay registry, and the traps
// that stop the game when it reaches something the runtime cannot continue from.
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include "rt.h"

uint8_t rdram[RDRAM_SIZE];

// ---- Fatal errors and the log of unknown addresses -----------------------------------------------------

static FatalHandler fatal_handler;

void rt_set_fatal_handler(FatalHandler fn) { fatal_handler = fn; }

__attribute__((noreturn)) void rt_fatal(const char *fmt, ...) {
  char message[256];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(message, sizeof message, fmt, ap);
  va_end(ap);
  if (fatal_handler) fatal_handler(message);
  fprintf(stderr, "fatal: %s\n", message);
  abort();
}

#define MISSING_MAX 512
static struct { uint32_t addr, hits; } missing[MISSING_MAX];
static uint32_t missing_n;

uint32_t rt_missing_count(void) { return missing_n; }

int rt_missing_get(uint32_t index, uint32_t *addr, uint32_t *hits) {
  if (index >= missing_n) return 0;
  *addr = missing[index].addr;
  *hits = missing[index].hits;
  return 1;
}

static void log_missing(uint32_t addr) {
  for (uint32_t k = 0; k < missing_n; k++) {
    if (missing[k].addr == addr) { missing[k].hits++; return; }
  }
  if (missing_n < MISSING_MAX) { missing[missing_n].addr = addr; missing[missing_n].hits = 1; missing_n++; }
}

// ---- Dispatch --------------------------------------------------------------------------------------------

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
  GuestFn fn = OOT_RESUMING() ? rt_resume_target(c) : oot_lookup(addr);
  if (!fn) rt_missing(c, addr);
  fn(c);
}

// ---- Shadow stack ----------------------------------------------------------------------------------------

__attribute__((noreturn)) void rt_sh_overflow(Cpu *c) {
  (void)c;
  rt_fatal("the guest call chain is deeper than %d calls", OOT_SH_MAX);
}

__attribute__((noreturn)) void rt_resume_bad(Cpu *c) {
  rt_fatal("a rebuilt call chain names call site %u, which the function it entered does not have", c->sh[c->rpos - 1]);
}

__attribute__((noinline)) void rt_resume_call(Cpu *c, GuestFn fn) { fn(c); }

__attribute__((noreturn)) void rt_missing(Cpu *c, uint32_t addr) {
  log_missing(addr);
  rt_fatal("missing function at 0x%08x (return address 0x%08x)", addr, (uint32_t)c->r[31]);
}

// ---- Overlay registry ------------------------------------------------------------------------------------

int rt_overlay_map(uint32_t link_start, uint32_t load_addr) {
  ImageInfo *target = NULL;
  for (uint32_t k = 0; k < oot_image_count; k++) {
    if (oot_images[k].overlay && oot_images[k].link_start == link_start) target = &oot_images[k];
  }
  if (!target) return 0;
  target->delta = load_addr - link_start;
  uint32_t lo = load_addr, hi = load_addr + (target->link_end - target->link_start);
  // The game reuses RAM for overlays: whatever occupied the range is gone.
  for (uint32_t k = 0; k < oot_image_count; k++) {
    ImageInfo *im = &oot_images[k];
    if (im == target || !im->overlay || !im->loaded) continue;
    uint32_t a = im->link_start + im->delta, b = im->link_end + im->delta;
    if (a < hi && lo < b) im->loaded = 0;
  }
  target->loaded = 1;
  return 1;
}

void rt_overlay_unmap(uint32_t link_start) {
  for (uint32_t k = 0; k < oot_image_count; k++) {
    if (oot_images[k].overlay && oot_images[k].link_start == link_start) oot_images[k].loaded = 0;
  }
}

// The game's own loader reads, relocates and clears the overlay; the registry learns where it went.
// overlay_load(romStart, romEnd, linkStart, linkEnd, dst) returns the size it loaded.
extern void fn_800cd428(Cpu *c) __attribute__((weak));

void rt_overlay_load(Cpu *c) {
  uint32_t link_start, dst;
  if (c->resume) {
    // Re-entered while a call chain is rebuilt: the arguments are in the routine's frame, since the loader below clobbered the registers.
    if (c->sh[c->rpos] != RT_FRAME_OVERLAY_LOAD) rt_fatal("a rebuilt call chain enters the overlay loader without its frame");
    link_start = c->sh[c->rpos + 1];
    dst = c->sh[c->rpos + 2];
    c->rpos += 3;
  } else {
    link_start = ARG(2);
    dst = STACK_ARG(4);
    OOT_PUSH(RT_FRAME_OVERLAY_LOAD);
    OOT_PUSH(link_start);
    OOT_PUSH(dst);
  }
  if (!fn_800cd428) rt_missing(c, 0x800cd428);
  fn_800cd428(c);
  c->shn -= 3;
  if (!rt_overlay_map(link_start, dst)) rt_fatal("overlay_load: no recompiled overlay links at 0x%08x", link_start);
}

// ---- Exceptions and COP0 ---------------------------------------------------------------------------------

__attribute__((noreturn)) void rt_trap(Cpu *c, int kind, uint32_t pc, uint32_t code) {
  (void)c;
  rt_fatal("exception %d at 0x%08x (code %u)", kind, pc, code);
}

__attribute__((noreturn)) void rt_unimpl(Cpu *c, uint32_t pc, uint32_t word) {
  (void)c;
  rt_fatal("untranslated instruction 0x%08x at 0x%08x", word, pc);
}

__attribute__((noreturn)) void rt_eret(Cpu *c) {
  (void)c;
  rt_fatal("eret outside an exception");
}

static uint64_t cop0[32];

uint64_t rt_mfc0(Cpu *c, uint32_t reg) {
  (void)c;
  reg &= 31;
  if (reg == 9) return (uint32_t)rt_clock();
  if (reg == 12) return rt_status;
  return cop0[reg];
}

void rt_mtc0(Cpu *c, uint32_t reg, uint64_t value) {
  (void)c;
  reg &= 31;
  if (reg == 12) rt_status = (uint32_t)value;
  else if (reg != 9) cop0[reg] = value;
}

void rt_tlb(Cpu *c, int op, uint32_t pc) { (void)c; (void)op; (void)pc; }
void rt_cache(Cpu *c, uint32_t op, uint32_t addr) { (void)c; (void)op; (void)addr; }

// ---- Saved state -------------------------------------------------------------------------------------------
// COP0 registers, and the overlay registry: for every overlay image, where it sits in RAM, if it does.

int dispatch_save(Writer *w) {
  for (int k = 0; k < 32; k++) put64(w, cop0[k]);
  return 1;
}

int dispatch_load(Reader *r, int apply) {
  uint64_t regs[32];
  for (int k = 0; k < 32; k++) regs[k] = get64(r);
  if (r->bad) return rt_state_refuse("the COP0 state is damaged");
  if (apply) memcpy(cop0, regs, sizeof regs);
  return 1;
}

int overlays_save(Writer *w) {
  uint32_t n = 0;
  for (uint32_t k = 0; k < oot_image_count; k++) n += oot_images[k].overlay != 0;
  put32(w, n);
  for (uint32_t k = 0; k < oot_image_count; k++) {
    const ImageInfo *im = &oot_images[k];
    if (!im->overlay) continue;
    put32(w, k);
    put32(w, im->link_start);
    put32(w, (uint32_t)im->loaded);
    put32(w, im->delta);
  }
  return 1;
}

int overlays_load(Reader *r, int apply) {
  uint32_t n = get32(r);
  if (r->bad || n > oot_image_count) return rt_state_refuse("the overlay registry of the state is damaged");
  if (apply) {
    for (uint32_t k = 0; k < oot_image_count; k++) {
      if (oot_images[k].overlay) oot_images[k].loaded = 0;
    }
  }
  for (uint32_t j = 0; j < n; j++) {
    uint32_t k = get32(r), link = get32(r), loaded = get32(r), delta = get32(r);
    if (r->bad) return rt_state_refuse("the overlay registry of the state is damaged");
    if (k >= oot_image_count || !oot_images[k].overlay || oot_images[k].link_start != link || loaded > 1) {
      return rt_state_refuse("this build has no overlay image %u linked at 0x%08x", k, link);
    }
    if (apply) {
      oot_images[k].loaded = (int)loaded;
      oot_images[k].delta = delta;
    }
  }
  return 1;
}
