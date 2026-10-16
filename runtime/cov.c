// Coverage builds (-DOOT_COVERAGE): which recompiled functions ran, how often each replaced OS routine was called, and
// which guest addresses beyond RDRAM were touched. Other builds export the same entry points with empty results.
#include <emscripten.h>
#include "rt.h"

#ifdef OOT_COVERAGE

// Recompiled code lives in 0x80000000 + COVERAGE_WINDOW: the boot code, the main code and the overlays at their link addresses.
#define COVERAGE_WINDOW 0x1000000u
#define FN_SLOTS (COVERAGE_WINDOW / 4)
#define OUTSIDE_MAX 512

extern const uint32_t oot_os_cov_count;
extern const uint32_t oot_os_cov_addr[];

static uint8_t fn_seen[FN_SLOTS / 8];
static uint32_t os_hits[1024];
static uint32_t last_entered;
// Loop iterations per video frame beyond which the frame is taken for a hang (a frame of the game takes well under 10 million).
#define LOOP_LIMIT 200000000u
static uint32_t loop_ticks;
// Accesses beyond RDRAM, grouped by 256-byte block; `addr` is the first address touched in the block.
static struct { uint32_t addr, hits, in_function; } mmio[OUTSIDE_MAX];
static uint32_t mmio_n;

void rt_cov_enter(uint32_t addr) {
  last_entered = addr;
  uint32_t slot = (addr & (COVERAGE_WINDOW - 1)) >> 2;
  fn_seen[slot >> 3] |= (uint8_t)(1u << (slot & 7));
}

void rt_cov_loop(uint32_t addr) {
  if (++loop_ticks > LOOP_LIMIT) rt_fatal("watchdog: over %u loop iterations in one video frame, at the loop 0x%08x (last function entered: 0x%08x)", LOOP_LIMIT, addr, last_entered);
}

void rt_cov_frame(void) { loop_ticks = 0; }

void rt_cov_os(uint32_t index) { os_hits[index]++; }

void rt_cov_outside(uint32_t addr) {
  for (uint32_t k = 0; k < mmio_n; k++) {
    if ((mmio[k].addr >> 8) == (addr >> 8)) { mmio[k].hits++; return; }
  }
  if (mmio_n < OUTSIDE_MAX) { mmio[mmio_n].addr = addr; mmio[mmio_n].hits = 1; mmio[mmio_n].in_function = last_entered; mmio_n++; }
}

EMSCRIPTEN_KEEPALIVE const uint8_t *oot_cov_functions(void) { return fn_seen; }
EMSCRIPTEN_KEEPALIVE uint32_t oot_cov_os_count(void) { return oot_os_cov_count; }
EMSCRIPTEN_KEEPALIVE uint32_t oot_cov_os_addr(uint32_t i) { return oot_os_cov_addr[i]; }
EMSCRIPTEN_KEEPALIVE uint32_t oot_cov_os_hits(uint32_t i) { return os_hits[i]; }
EMSCRIPTEN_KEEPALIVE uint32_t oot_cov_mmio_count(void) { return mmio_n; }
// Field 0 is the first address touched in the block, 1 the number of accesses, 2 the function entered last at that first access.
EMSCRIPTEN_KEEPALIVE uint32_t oot_cov_mmio(uint32_t i, uint32_t field) {
  return field == 0 ? mmio[i].addr : field == 1 ? mmio[i].hits : mmio[i].in_function;
}
EMSCRIPTEN_KEEPALIVE uint32_t oot_cov_enabled(void) { return 1; }

#else

void rt_cov_frame(void) {}

EMSCRIPTEN_KEEPALIVE const uint8_t *oot_cov_functions(void) { return 0; }
EMSCRIPTEN_KEEPALIVE uint32_t oot_cov_os_count(void) { return 0; }
EMSCRIPTEN_KEEPALIVE uint32_t oot_cov_os_addr(uint32_t i) { (void)i; return 0; }
EMSCRIPTEN_KEEPALIVE uint32_t oot_cov_os_hits(uint32_t i) { (void)i; return 0; }
EMSCRIPTEN_KEEPALIVE uint32_t oot_cov_mmio_count(void) { return 0; }
EMSCRIPTEN_KEEPALIVE uint32_t oot_cov_mmio(uint32_t i, uint32_t field) { (void)i; (void)field; return 0; }
EMSCRIPTEN_KEEPALIVE uint32_t oot_cov_enabled(void) { return 0; }

#endif
