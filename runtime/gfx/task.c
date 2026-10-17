// Entry points for the game module: the display list of a graphics task runs over the guest's RDRAM.
#include <string.h>
#include "cpu.h"
#include "gfx.h"

// A list that runs this many commands is taken to be runaway and stopped.
#define MAX_COMMANDS 5000000u

// `start` is the display list's address as the task record gives it. Returns the number of commands executed.
uint32_t gfx_run(uint32_t start) { return gfx_run_ram(rdram, RDRAM_SIZE, start, MAX_COMMANDS); }

// A copy of RDRAM that later runs can read after the game has moved on. It is display data only: a saved state must not
// carry it (gfx_forget_kept empties it first).
static uint8_t kept_ram[RDRAM_SIZE];

void gfx_keep(void) { memcpy(kept_ram, rdram, RDRAM_SIZE); }

uint32_t gfx_run_kept(uint32_t start) { return gfx_run_ram(kept_ram, RDRAM_SIZE, start, MAX_COMMANDS); }

void gfx_forget_kept(void) { memset(kept_ram, 0, RDRAM_SIZE); }
