# Runtime: memory and OS services

`runtime/` is the hand-written C that the recompiled code runs on. The recompiler binds every OS routine
listed in `docs/re/os-routines.md` to a weak function `rt_<id>(Cpu *c)`; the files here define those symbols, so
they replace the recompiled bodies. A replacement reads its arguments from the CPU context (`a0`–`a3`, then the
caller's stack from `sp+16`, floats in `$f12`) and returns in `$v0` (`$v0:$v1` for 64-bit results).

| File | Contents |
| --- | --- |
| `cpu.h` | CPU context, big-endian memory access, FPU helpers |
| `dispatch.c` | RDRAM, `oot_lookup` / `rt_call`, the log of unknown addresses, the overlay registry, COP0, traps |
| `sched.c` | threads on fibers, the run queue, message queues, events, interrupt state |
| `clock.c` | virtual clock, timed device events, `osGetCount`/`osGetTime`, timers |
| `pi.c` | cartridge ROM and save memory, PI DMA, word access |
| `vi.c` | VI contexts and the 50 Hz retrace |
| `cont.c` | controllers |
| `rsp.c` | RSP task submission, RDP status, audio interface |
| `osinit.c` | `osInitialize`, cache and TLB no-ops, `rt_reset` |
| `rt.h` | host interface and shared declarations |

## Guest-visible state

The OS keeps its bookkeeping in the game's memory and the replacements use the same locations and record layouts
(`OSThread`, `OSMesgQueue`, `OSTimer`, `OSViContext`, `OSIoMesg`, `OSTask`, `OSContPad`, `OSContStatus`; offsets
in `rt.h` and at the top of each file, from the evidence in `os-routines.md` and the disassembly of the callers).
The empty-list node `0x80006850` (priority −1), the run-queue head `0x80006858`, the all-threads head
`0x8000685c` and the running-thread word `0x80006860` live in the boot image's initialised data (checked against
the ROM), so the runtime relies on the loaded boot image for them. Code that reads a queue's valid count or a
thread's priority directly sees the values the original would hold.

## Scheduling

- Each thread is an Emscripten fiber with its own `Cpu` (initial FCSR `0x01000800`, FR clear as in the initial
  Status `0xff03`) and its own stacks. The build needs `-sASYNCIFY`.
- Scheduling is cooperative. A thread gives up the processor only inside an OS call that blocks, yields, or makes
  a higher-priority thread runnable (`osStartThread`, a send that wakes a receiver, `osSetThreadPri`, ...). Order
  follows the original: higher priority number first, arrival order among equals; `osYieldThread` re-queues
  behind equals.
- `rt_run(until)` is the scheduler loop and runs on the host's context. It resumes the first runnable thread;
  with none, it advances the clock to the next device event, or returns `RT_RUN_IDLE` when none is left or
  `RT_RUN_TIME` at `until`.
- `rt_start(entry, sp)` runs the boot code as a pseudo-context. The first `osStartThread` abandons it, as the
  original dispatcher never returns to its caller.
- A thread that lowers itself to priority 0 (`boot_idle_thread` does, then spins at `0x800007c0`) is parked and
  never resumed: its loop does not call the OS, so running it would never return.
- A thread whose entry function returns is destroyed, which is what the exit stub at `0x80002e90` does.
- Interrupts are only taken at the points above, so `osSetIntMask`, `__osDisableInt` and friends only keep the
  values the game reads back.

## Time

The clock counts Count ticks: 46 875 000 per second (`osInitialize` stores `osClockRate * 3 / 4` with the data
word `62 500 000`, and `osContInit` waits for `0x0165a0bc` = half a second of them). It moves when the scheduler is
idle, when a thread resumes (500 ticks), and when a polling call (`osGetCount`, `osGetTime`,
`osViGetCurrentFramebuffer`, `osAiGetLength`) charges 16 ticks, so that a loop waiting on the clock progresses.
`mfc0 Count` reads it. Device latencies (`PI_SETUP_CYCLES` and the other constants in `rt.h`) are model values,
not measurements; only the order of completions is relied upon.

## Devices

- **PI.** `osEPiStartDma` returns −1 without a PI manager (`osCreatePiManager` sets the flag at `0x80006890` and
  the command queue at `0x80006898`). Otherwise the request is queued, the transfer is carried out when its time
  comes (one transfer at a time, in request order) and the request pointer is sent to its reply queue. The device
  address is `handle->base | devAddr`; `0x10000000`+ is the ROM (read-only, zero beyond the image), `0x08000000`+
  the save memory (`rt_sram`, `rt_sram_take_dirty`). The request priority byte, which makes the original post at
  the front of the command queue, has no effect since there is no queue to reorder.
- **VI.** `osViSet*` edit the next context and set state bits; every 1/50 s the pending edits are committed to the
  current context and `osViSetEvent`'s message is sent every `n`th retrace. `rt_vi_get` gives the renderer the
  framebuffer in effect.
- **Controllers.** `osContInit` blocks until half a second, then reports the ports in `rt_pad_connect`.
  `osContStartReadData` / `osContStartQuery` wait for the first SI completion on the queue as the original does,
  latch the pads, and raise a second completion, which the game waits for. Completions go through the event
  registered for `EVENT_SI`, or straight to the queue when none is.
- **RSP / RDP.** A task is never executed. `osSpTaskStartGo` decodes the `OSTask` and calls the graphics or audio
  hook (`rt_set_gfx_hook`, `rt_set_audio_hook`); the `SP` event (and `DP` for graphics) follows after the modelled
  time. Tasks never yield.
- **AI.** Two buffers, each playing for `length / 4` frames at `rt_ai_set_rate`; the `AI` event marks the end of
  each. `osAiSetNextBuffer` returns −1 with both taken. The original's workaround for buffers that end on an
  `0x2000` boundary is not modelled.

## Dispatch and overlays

`oot_lookup` searches the loaded images. An overlay is found only at the address `rt_overlay_map` registered
for it; mapping one over the RAM of another unloads that one. `rt_overlay_load` wraps the recompiled
`overlay_load` (`fn_800cd428`), which does the reading, relocating and clearing, then registers the overlay at the
destination. Addresses that no image holds are logged (`rt_missing_get`) and end the run with a message.

## Tests

`runtime/tests/*.c` are built with Emscripten together with the runtime and run in Node by
`tools/runtime/runtime.test.ts`, one vitest case per C test. They use no ROM; guest threads are C functions
registered in a stand-in dispatch table.
