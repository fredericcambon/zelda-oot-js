// Entry point for the game module: the display list of a graphics task runs over the guest's RDRAM.
#include "cpu.h"
#include "gfx.h"

// A list that runs this many commands is taken to be runaway and stopped.
#define MAX_COMMANDS 5000000u

// `start` is the display list's address as the task record gives it. Returns the number of commands executed.
uint32_t gfx_run(uint32_t start) { return gfx_run_ram(rdram, RDRAM_SIZE, start, MAX_COMMANDS); }
