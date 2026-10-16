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

## Portable save states

A raw dump of the module's memory is tied to the wasm file that made it: every guest thread runs on a fiber whose C stack
and Asyncify stack hold host frames and wasm-internal indices (`runtime/sched.c`, `start_fiber`). Everything else the game
depends on is data of the guest or of the runtime. This section covers the part that rebuilds the fibers from build-independent
facts: which of the ROM's functions are active on each thread, and where the thread waits. The file around it (RDRAM,
devices, clock) is described with the state format.

### What is described

`rt_threads_describe` (exported as `oot_threads_describe`) writes, between two `oot_frame()` calls, the words that
`tools/runtime/threads.ts` reads and writes (`parseThreads`, `encodeThreads`):

- `running` (always 0 between frames), `rt_status` and the interrupt mask;
- for each thread record: its slot in the thread table, the `OSThread` address, the entry function, whether it has started and
  whether it is parked (the idle loop); the guest registers (`r[32]`, `hi`, `lo`, `llbit`, `f[32]`, `fcsr`, `fir`, `fr`); the
  blocking site; and the call chain, outermost frame first.

A frame is a call in progress: the image (index in `oot_images`), the entry address of the function holding the call, and the
address of the call instruction, all as linked, so that an overlay's frames do not depend on where it was loaded. The
description contains no host address, no heap pointer and nothing about the wasm file.

It is refused with a message (`oot_state_error`) when the boot code is still running (`boot_live`), when a thread is
running or being destroyed, when a started thread waits anywhere but at a blocking site, or when its chain is not made of
call sites that end in one. `rt_threads_rebuild` (`oot_threads_rebuild`, then `oot_threads_rebuilt`) checks the whole
description against the build's tables before it touches anything: a wrong magic number, a short buffer, a duplicate
thread, a blocking site or runtime frame the build lacks, or a function and call address that are not in `oot_sites` refuse it
and leave the threads as they were.

### Shadow stack

The context of each thread (`Cpu`, `runtime/cpu.h`) holds a shadow stack of 1,024 words and its depth `shn`. A recompiled
function that calls another pushes the key of the call site before the call and pops it after (`OOT_PUSH`, `OOT_POP`):

| Call | Key pushed |
|---|---|
| `jal`, `bgezal`, `bltzal` and the likely forms, `j` or a branch to another function (a tail call), the fall into the next function | the call site |
| `jalr`, `jr` that is not a return, the default case of a jump table | the call site; the target is not recorded, the next frame names the callee |

A key is an index into `oot_sites` (generated `sites.c`): the function holding the site (`fn`), its entry address and the
address of the call. Keys are assigned by the generator in the order of the images and functions, so they differ between
builds; the description translates them (`find_site` and `oot_sites[key]`). A jump table's `jr` has one call site: a case that
leaves the function takes the lookup of the default case. The fall into the next function has the address just past the
function.

A runtime routine that calls recompiled code and uses its own values afterwards keeps them in a frame on the same stack: a
frame id at or above `RT_FRAME_BASE` (`0xF0000000`) and its payload words. Two do: `rt_overlay_load` (`RT_FRAME_OVERLAY_LOAD`, payload: link address and load address, which the loader below it overwrites in the registers),
and `osContStartReadData`/`osContStartQuery` (`RT_FRAME_CONT_TRANSFER`, payload: the queue and whether it is a read), which wait in an `osRecvMesg`
of their own and so are the routine the chain ends in; the blocking site is that receive's.

**Calls without a frame.** A thread is parked only inside the routines of `blocking_routine` (below), so a call that cannot reach
one leaves no host frame on a parked thread. The generator computes the functions that can suspend: those with a call through
the dispatch tables, those that call a routine of `SUSPENDING_ROUTINES` (`tools/recomp/generate.ts`), and those that call such
a function. A direct call to any other function pushes nothing. In the PAL ROM this leaves 11,268 of 53,023 call sites with a
frame (`docs/re/gaps.md`). `tools/recomp/shadow.test.ts` checks that `SUSPENDING_ROUTINES` is the set of routines of
`blocking_routine` plus the overlay loader. A routine added to `blocking_routine` has to be added to the list.

### Blocking sites

A thread that is not running waits at one of these sites. The numbers are part of the description (`BS_*` in `runtime/rt.h`);
new sites take new numbers.

| Id | Routine (address in the PAL ROM) | Site |
|---|---|---|
| 1, 2 | `osRecvMesg` (`0x800021a0`) | waiting for a message; preempted after receiving one |
| 3, 4 | `osSendMesg` (`0x80001f80`) | waiting for room; preempted after sending |
| 5, 6 | `osJamMesg` (`0x80004490`) | the same |
| 7 | `osYieldThread` (`0x80005bc0`) | behind its equals |
| 8 | `osStopThread` (`0x800020d0`) on the running thread | stopped |
| 9 | `osStartThread` (`0x800061e0`) | preempted by the thread it made runnable |
| 10, 11 | `osSetThreadPri` (`0x800045e0`) | lowered itself to 0 (the idle loop); preempted by the new order |
| 12, 13, 14, 15 | `osGetCount` (`0x80004f00`), `osGetTime` (`0x80004a70`), `osAiGetLength` (`0x800d39a0`), `osViGetCurrentFramebuffer` (`0x800d63b0`) | preempted in `rt_poll` while charging time |
| 16 | `osContInit` (`0x800d0690`) | sleeping until half a second after reset |

The thread's own lists in RDRAM already say what it waits on (`TH_STATE`, `TH_QUEUE`, the run queue), so the site holds
no further values: each routine takes its arguments again from the registers, which are those of the call. A blocking
primitive (`block_on`, `leave_cpu`, `requeue_running`, `yield_if_preempted`, `thread_sleep_until`) records the site in
`blk_id` before it swaps to the host and clears it when the thread runs again.

### Resume mode

`rt_threads_rebuild` starts a fresh fiber for each started thread with its shadow stack filled in, `resume` set, `rpos` at 0
and `blk_id` at the recorded site, and runs it until it parks:

1. The fiber calls the thread's entry function through `rt_call`. In resume mode `rt_call` ignores its address and calls the
   function of the call site at `sh[rpos]` (`rt_resume_target`).
2. A generated function with call sites begins with `if (c->resume) goto resume_entry`. There it takes the site at `sh[rpos++]`,
   jumps to the code that re-issues that call (`Q_<key>`: `rt_resume_call(c, callee)`, or `rt_call(c, 0)` for an indirect
   call) and, when the call returns, continues at the label right after it (`D_<key>`), which pops the frame.
3. A runtime routine finds `c->resume` set and `blk_id` at one of its sites (`resuming_at`) and jumps to the blocking
   primitive of that site, skipping the code before it. The primitive, seeing `blk_id` set, leaves the guest state alone and only
   parks the fiber (`rebuilding`). `rt_overlay_load` reads its frame from the stack instead and calls the loader again.
4. The thread is now where the original was, and runs on normally when the scheduler resumes it.

Nothing of the guest state is touched on the way: the code that the chain skips has run already, and its results are in the
registers, RDRAM and the lists.

### No C local lives across a call

Re-entering a function at a call site skips everything before it, so no value may be held in a C local across a call that has
a frame. The emitter guarantees it by construction and checks it for every function it generates:

- every guest register, `hi`/`lo`, the FPU registers and `llbit` live in `Cpu`; plain instructions use C locals only inside
  their own braces (the result of a checked add, the address and result of `ll`/`sc`), and contain no call;
- a delay slot runs before the call it belongs to, in the same statement; a slot that is also a jump target gets a standalone
  copy that contains no call; a branch-likely runs its slot inside the taken branch before the call;
- the condition of a branch (`cnd`) is read before the call, and nothing after it;
- the target of `jalr`/`jr` (`t`) is read before the slot and is only the argument of the call; in resume mode the callee comes
  from the next frame, not from `t`;
- a jump table's `switch` calls only from its default case; the other cases are `goto` within the function;
- code shared by two routines is a function of its own with its own call sites, and the fall into the next function is a call.

`liveLocalsAfterCalls` (`tools/recomp/emit.ts`) scans the C text of each function: a local declared in a block and read after a
call with a frame (the `D_<key>:` label) in the same or an enclosing block, or a local declared at function level, throws, and
the generator reports the function. It passes for all 13,367 functions of the PAL ROM, and
`tools/recomp/shadow.test.ts` runs it on each of the patterns above and on code that breaks the rule.

### Adding a blocking site or a runtime frame

- A new place where a thread can park gets a `BS_` id in `runtime/rt.h` (appended), calls its primitive with the id, and begins
  with `resuming_at(c, id)` followed by a `goto` to the primitive's call; the routine goes into `blocking_routine`
  and, in `SUSPENDING_ROUTINES`, the generator's list. Values that cannot be taken again from the registers or RDRAM go in
  a runtime frame (`RT_FRAME_*` in `rt.h`, a case in `chain_next`, `rt_resume_target` and the frame cases of describe and
  rebuild).
- Tests: `runtime/tests/t_chain.c` has generated-style functions and the scenarios (blocked, preempted, sleeping, inside the
  loader, refused descriptions); the ROM-gated test in `tools/headless/headless.test.ts` rebuilds the threads of the scripted
  new game in a fresh game and replays 180 frames.

## Tests

`runtime/tests/*.c` are built with Emscripten together with the runtime and run in Node by
`tools/runtime/runtime.test.ts`, one vitest case per C test. They use no ROM; guest threads are C functions
registered in a stand-in dispatch table (`oot_sites` stands in for the generated table in `t_chain.c`).
