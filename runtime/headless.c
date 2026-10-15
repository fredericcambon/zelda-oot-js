// Host entry points for running the recompiled game without a display: Node (or the browser shell) hands over
// the ROM, the game is booted, and the run is stepped one video frame at a time.
#include <stdio.h>
#include <string.h>
#include <emscripten.h>
#include "rt.h"

// The boot image: ROM offset 0x1000 is copied to the entry address 0x80000400 of the header (the console's IPL
// does that before the first instruction). Execution starts at boot_main; boot_entry only zeroes the BSS
// (0x80006d50-0x80009770), which a fresh RDRAM already is.
#define BOOT_ROM_OFFSET 0x1000u
#define BOOT_LOAD_ADDR 0x80000400u
#define BOOT_IMAGE_SIZE 0x6950u
#define BOOT_MAIN 0x80000498u
#define BOOT_STACK 0x80007740u

static uint32_t frames_done;
static uint32_t gfx_tasks, audio_tasks;
static char fatal_message[256];
static uint64_t frame_end;
static int idle;

// The host sees a graphics task while the memory it points into is still as the game left it.
EM_JS(void, host_gfx_task, (uint32_t type, uint32_t data, uint32_t size, uint32_t task), {
  if (Module.onGfxTask) Module.onGfxTask(data, size, task);
});

static void on_gfx(const RspTask *t) {
  gfx_tasks++;
  host_gfx_task(t->type, t->data_ptr, t->data_size, t->addr);
}
static void on_audio(const RspTask *t) { (void)t; audio_tasks++; }

static void on_fatal(const char *message) {
  snprintf(fatal_message, sizeof fatal_message, "%s", message);
  // Unwinds out of the fiber that raised it; the JS host reads the message afterwards.
  emscripten_throw_string(fatal_message);
}

// Boots the game from a big-endian ROM image of `size` bytes. The runtime keeps the pointer.
EMSCRIPTEN_KEEPALIVE void oot_boot(const uint8_t *rom, size_t size) {
  rt_reset();
  memset(rdram, 0, sizeof rdram);
  frames_done = gfx_tasks = audio_tasks = 0;
  fatal_message[0] = 0;
  rt_rom_set(rom, size);
  rt_set_fatal_handler(on_fatal);
  rt_set_gfx_hook(on_gfx);
  rt_set_audio_hook(on_audio);
  memcpy(mem_ptr(BOOT_LOAD_ADDR), rom + BOOT_ROM_OFFSET, BOOT_IMAGE_SIZE);
  rt_boot_state();
  frame_end = 0;
  idle = 0;
  rt_start(BOOT_MAIN, BOOT_STACK);
}

// Runs until the next video retrace interval ends. oot_idle then tells whether nothing can ever run again.
// (The result is not the return value: an export that suspends on a fiber switch does not hand one back reliably.)
EMSCRIPTEN_KEEPALIVE void oot_frame(void) {
  frame_end += RT_CPU_COUNTER / RT_VI_HZ;
  int r = rt_run(frame_end);
  frames_done++;
  idle = r == RT_RUN_IDLE;
}

EMSCRIPTEN_KEEPALIVE int oot_idle(void) { return idle; }

EMSCRIPTEN_KEEPALIVE uint32_t oot_frames(void) { return frames_done; }
EMSCRIPTEN_KEEPALIVE uint32_t oot_gfx_tasks(void) { return gfx_tasks; }
EMSCRIPTEN_KEEPALIVE uint32_t oot_audio_tasks(void) { return audio_tasks; }
EMSCRIPTEN_KEEPALIVE uint32_t oot_retraces(void) { RtVi v; rt_vi_get(&v); return v.retraces; }
EMSCRIPTEN_KEEPALIVE uint32_t oot_vi_framebuffer(void) { RtVi v; rt_vi_get(&v); return v.framebuffer; }
EMSCRIPTEN_KEEPALIVE const char *oot_fatal_message(void) { return fatal_message; }
EMSCRIPTEN_KEEPALIVE const uint8_t *oot_rdram(void) { return rdram; }
EMSCRIPTEN_KEEPALIVE uint32_t oot_rd32(uint32_t addr) { return rd32(addr); }

// ---- Call trace (debug builds) --------------------------------------------------------------------------------

#define TRACE_RING 4096u
static uint32_t trace_ring[TRACE_RING];
static uint32_t trace_total;

void rt_trace_enter(uint32_t addr) { trace_ring[trace_total++ % TRACE_RING] = addr; }

// Number of function entries recorded so far, and the entry `back` calls before the latest (0 is the latest).
EMSCRIPTEN_KEEPALIVE uint32_t oot_trace_count(void) { return trace_total; }
EMSCRIPTEN_KEEPALIVE uint32_t oot_trace_at(uint32_t back) {
  return back < TRACE_RING && back < trace_total ? trace_ring[(trace_total - 1 - back) % TRACE_RING] : 0;
}
