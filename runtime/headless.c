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
static const uint8_t *boot_rom;
static size_t boot_rom_size;

// The host sees a graphics task while the memory it points into is still as the game left it.
EM_JS(void, host_gfx_task, (uint32_t type, uint32_t data, uint32_t size, uint32_t task), {
  if (Module.onGfxTask) Module.onGfxTask(data, size, task);
});

static void on_gfx(const RspTask *t) {
  gfx_tasks++;
  host_gfx_task(t->type, t->data_ptr, t->data_size, t->addr);
}
// The host runs the command list while the memory it points into is as the game left it, and writes the samples into
// the memory the game later hands to the audio interface.
EM_JS(void, host_audio_task, (uint32_t data, uint32_t size, uint32_t microcode, uint32_t microcode_data), {
  if (Module.onAudioTask) Module.onAudioTask(data, size, microcode, microcode_data);
});
EM_JS(void, host_ai_buffer, (uint32_t addr, uint32_t length, uint32_t hz), {
  if (Module.onAiBuffer) Module.onAiBuffer(addr, length, hz);
});

static void on_audio(const RspTask *t) {
  audio_tasks++;
  host_audio_task(t->data_ptr, t->data_size, t->ucode, t->ucode_data);
}
static void on_ai(uint32_t addr, uint32_t length) { host_ai_buffer(addr, length, rt_ai_rate()); }

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
  boot_rom = rom;
  boot_rom_size = size;
  rt_rom_set(rom, size);
  rt_set_fatal_handler(on_fatal);
  rt_set_gfx_hook(on_gfx);
  rt_set_audio_hook(on_audio);
  rt_set_ai_hook(on_ai);
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
  rt_cov_frame();
  int r = rt_run(frame_end);
  frames_done++;
  idle = r == RT_RUN_IDLE;
}

EMSCRIPTEN_KEEPALIVE int oot_idle(void) { return idle; }

EMSCRIPTEN_KEEPALIVE uint32_t oot_frames(void) { return frames_done; }
EMSCRIPTEN_KEEPALIVE uint32_t oot_gfx_tasks(void) { return gfx_tasks; }
EMSCRIPTEN_KEEPALIVE uint32_t oot_audio_tasks(void) { return audio_tasks; }
EMSCRIPTEN_KEEPALIVE uint32_t oot_jpeg_tasks(void) { return rt_jpeg_tasks(); }
EMSCRIPTEN_KEEPALIVE uint32_t oot_retraces(void) { RtVi v; rt_vi_get(&v); return v.retraces; }
EMSCRIPTEN_KEEPALIVE const char *oot_fatal_message(void) { return fatal_message; }
EMSCRIPTEN_KEEPALIVE const uint8_t *oot_rdram(void) { return rdram; }
// Where the cartridge image sits in the module's memory. It is read-only, so a saved state leaves it out.
EMSCRIPTEN_KEEPALIVE const uint8_t *oot_rom_base(void) { return boot_rom; }
EMSCRIPTEN_KEEPALIVE uint32_t oot_rom_size(void) { return (uint32_t)boot_rom_size; }
EMSCRIPTEN_KEEPALIVE uint32_t oot_rd32(uint32_t addr) { return rd32(addr); }

// Controller `port` (0-3) as the game reads it: OSContPad button bits, stick -128..127.
EMSCRIPTEN_KEEPALIVE void oot_pad_set(uint32_t port, uint32_t buttons, int32_t x, int32_t y) { rt_pad_set(port, (uint16_t)buttons, (int8_t)x, (int8_t)y); }

// The save memory (the cartridge's SRAM window) and whether the game wrote it since the last call.
EMSCRIPTEN_KEEPALIVE uint8_t *oot_sram(void) { return rt_sram(NULL); }
EMSCRIPTEN_KEEPALIVE uint32_t oot_sram_size(void) { size_t n; rt_sram(&n); return (uint32_t)n; }
EMSCRIPTEN_KEEPALIVE int oot_sram_take_dirty(void) { return rt_sram_take_dirty(); }

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

// ---- Saved state ----------------------------------------------------------------------------------------------

int headless_save(Writer *w) {
  put32(w, frames_done);
  put32(w, gfx_tasks);
  put32(w, audio_tasks);
  put64(w, frame_end);
  put32(w, (uint32_t)idle);
  return 1;
}

int headless_load(Reader *r, int apply) {
  uint32_t frames = get32(r), gfx = get32(r), audio = get32(r);
  uint64_t end = get64(r);
  uint32_t idle_now = get32(r);
  if (r->bad || idle_now > 1) return rt_state_refuse("the frame counters of the state are damaged");
  if (apply) {
    frames_done = frames;
    gfx_tasks = gfx;
    audio_tasks = audio;
    frame_end = end;
    idle = (int)idle_now;
  }
  return 1;
}

static int state_loaded;

// Writes the portable state (rt_state_save) into `buf`. Returns its size, or 0 with oot_state_error() set.
EMSCRIPTEN_KEEPALIVE uint32_t oot_state_save(uint8_t *buf, uint32_t cap) { return rt_state_save(buf, cap); }
// Loads a portable state; oot_state_loaded() tells whether it was accepted. Rebuilding the threads switches fibers,
// so the result is not the return value (see oot_frame).
EMSCRIPTEN_KEEPALIVE void oot_state_load(const uint8_t *buf, uint32_t len) { state_loaded = rt_state_load(buf, len); }
EMSCRIPTEN_KEEPALIVE int oot_state_loaded(void) { return state_loaded; }

// ---- Threads of a saved state ---------------------------------------------------------------------------------

static int threads_rebuilt;

// Describes the guest threads into `buf` (rt_threads_describe). Returns the size, or 0 with oot_state_error() set.
EMSCRIPTEN_KEEPALIVE uint32_t oot_threads_describe(uint8_t *buf, uint32_t cap) { return rt_threads_describe(buf, cap); }
// Rebuilds the threads from a description; oot_threads_rebuilt() tells whether it was accepted. Rebuilding switches
// fibers, so the result is not the return value (see oot_frame).
EMSCRIPTEN_KEEPALIVE void oot_threads_rebuild(const uint8_t *buf, uint32_t len) { threads_rebuilt = rt_threads_rebuild(buf, len); }
EMSCRIPTEN_KEEPALIVE int oot_threads_rebuilt(void) { return threads_rebuilt; }
EMSCRIPTEN_KEEPALIVE const char *oot_state_error(void) { return rt_state_error(); }
