# OS routines the runtime replaces

Every routine below was found in the PAL 1.0 ROM (SHA-1 `328a1f1beba30ce5e178f031662019eb32c5f3b5`) by `data/os-signatures.json`, which holds one rule per routine: a conjunction of checks on a function (opening instruction words, COP0 registers touched, cache and TLB instructions, hardware registers reached through constant addresses, constant RAM addresses, instruction and callee counts, and calls to routines already recognised). `tools/analyze/os.ts` accepts a rule only when exactly one function of its image matches; ambiguity is reported, never resolved by guessing. `tools/analyze/os.test.ts` (needs `OOT_ROM`) fails if a rule matches zero or several functions, if two ids share an address, or if the address cited first in a rule's evidence differs from the address found.

Addresses are virtual (KSEG0). Two images hold all of them: **boot** (`0x80000400`–`0x80006530` text, the code the IPL3 stage copies from ROM offset `0x1000`) and **code** (`0x800116E0` and up, file 28 of the file table). No OS routine lives in an overlay; overlays only call into these two images.

## Naming

Public SDK names (`osCreateThread`, `osSendMesg`, `osViSwapBuffer`, ...) are used where the observed behaviour and argument layout match what the official N64 SDK manuals document for that function. Routines the manuals do not document are named after their behaviour with the prefix `os_internal_`. Game-level helpers (`boot_*`, `dma_*`, `rom_file_load`, `overlay_*`, `sram_*`, `yaz0_decode`) get descriptive names too. A name is a label for an address; the claim is the evidence beside it.

## Conventions observed across the routines

- **Critical sections.** Thread, message, timer, VI and PI routines run their body between `os_internal_disable_int` (returns the previous Status bit 0) and `os_internal_restore_int` (ORs that bit back). Interrupts are the only mutual exclusion; there is one CPU and no spinlock.
- **Thread states.** Field `+0x10` of a thread record holds the state: 1 stopped, 2 runnable, 4 running, 8 waiting. `osStartThread`, `osStopThread`, `os_internal_dispatch_thread` and `os_internal_enqueue_and_yield` read and write exactly these values.
- **Queues.** Wait lists are linked lists ordered by descending priority (`os_internal_enqueue_thread`); an empty list points at the sentinel `0x80006850`. The run queue head is `0x80006858`, the running thread is the word at `0x80006860`, the all-threads list head is `0x8000685c`.
- **Blocking.** A routine blocks its caller by putting the thread on a wait list with `os_internal_enqueue_and_yield`. The thread runs again when another routine wakes the first waiter of that list (`osSendMesg` wakes receivers, `osRecvMesg` wakes senders) and the scheduler picks it. Nothing polls.
- **Hardware.** Device registers are reached through constant KSEG1 addresses (`0xA4040010` SP_STATUS, `0xA4300000` MI_MODE, `0xA4600010` PI_STATUS, `0xA4800018` SI_STATUS, `0xA4500004`/`0xA450000C` audio length and status). The routines in the SP, DP, AI, SI, PI, VI and start-up groups below are the ones recognised as touching them.

## Contracts the runtime has to honour

These are the effects that matter when a routine is replaced by C. Addresses and instruction-level evidence are in the reference below.

| Area | Contract |
| --- | --- |
| Threads | `osCreateThread(t, id, entry, arg, stackTop, pri)` only initialises the record (state 1; nothing runs). `osStartThread` makes it runnable and yields at once when it outranks the caller. Higher priority number runs first; `osYieldThread` re-queues behind equal priorities. `osSetThreadPri(0, p)` addresses the caller and yields when the caller no longer has the highest priority. A thread whose entry returns lands in the stub at `0x80002e90`, which calls `osDestroyThread(0)`. |
| Message queues | `osSendMesg(q, m, block)`: full queue returns -1 when `block` is 0 and blocks when it is 1. `osRecvMesg(q, &m, block)`: empty queue returns -1 for 0 and blocks for 1; the out pointer may be null. `osJamMesg` inserts at the front. A send wakes the first receiver, a receive the first sender. A message is one word. |
| Events | `osSetEventMesg(ev, q, m)` stores a pair in a table indexed by event; the exception handler (`os_internal_exception_send_event`) sends the pair when the interrupt arrives, and only when the queue has room. The handler passes the entry offset (index × 8) in `a0`: 3 count/compare (`0x80002808`), 4 SP (`0x800028ac`), 5 SI (`0x80002938`), 6 AI (`0x80002914`), 7 VI (`0x800028e8`), 8 PI (`0x80002964`), 9 DP (`0x80002990`); the other calls (`0x80002a2c`, `0x80002a0c`, `0x80002854`, `0x80002a48`, `0x800028c4`, `0x80002ac4`, `0x800029d8`) use 0, 1, 2, 10, 11, 12 and 14 respectively. The VI manager registers events 7 and 3 (`osCreateViManager`, `osSetEventMesg` calls at `0x80005f44` and `0x80005f5c`): 7 carries retrace, 3 the Count/Compare interrupt. |
| PI DMA | `osEPiStartDma(handle, req, dir)` returns -1 when no PI manager exists, otherwise posts the request and returns at once; completion arrives as a message on the reply queue named in the request. `dir` 0 reads the cartridge into RDRAM, non-zero writes it. `osEPiReadIo` and `osEPiWriteIo` are synchronous single-word accesses wrapped in `osPiGetAccess`/`osPiRelAccess`. |
| ROM files | `rom_file_load(dst, virtualRomAddr, size)` is synchronous: it posts to the DMA manager thread and blocks on a local reply queue. Compressed files are Yaz0-decoded by the manager (`dma_serve_request`). |
| VI | `osViSetMode`, `osViSwapBuffer`, `osViBlack`, `osViSetXScale`, `osViSetYScale` and `osViSetSpecialFeatures` only edit the *next* VI context and set flag bits; the VI manager commits them to the hardware at the next retrace (`os_internal_vi_swap_context`). `osViSetEvent(q, m, n)` makes the manager forward `m` to `q` on retrace. `osViGetNextFramebuffer` and `osViGetCurrentFramebuffer` return the stored pointers. |
| Timers | `osGetCount` returns COP0 Count. `osGetTime` is a saved 64-bit total plus the cycles since the last save. `osSetTimer(t, first, period, q, m)` queues the timer in an expiry-ordered list and re-arms Compare; the timer interrupt sends `m` to `q` on expiry and re-inserts periodic timers. `osStopTimer` returns -1 when the timer is not queued. |
| Controllers | `osContInit` waits until 0.5 s after reset (it blocks), then queries the PIF. `osContStartReadData(q)` starts a PIF transfer and signals `q` on completion; `osContGetReadData(pads)` decodes the answer (button halfword, signed stick x and y, error byte). |
| Saves | Save data lives in the cartridge SRAM window at `0x08000000`, reached with PI DMA through `sram_transfer(cartAddr, ram, size, dir)`. No EEPROM or FlashRAM routine exists in the binary. |
| RSP | `osSpTaskLoad(task)` writes the task back from the data cache, converts its pointers to physical addresses and DMAs microcode and data into the RSP; `osSpTaskStartGo` clears halt and broke; `osSpTaskYield` sets signal 0; `osSpTaskYielded` reads and clears it. Task completion has no routine of its own: the SP interrupt is delivered as an event by `os_internal_exception` to the queue registered with `osSetEventMesg`. |
| Cache and TLB | The cache routines have no effect visible on flat memory; a replacement may be empty. Only `os_internal_probe_tlb`, `osUnmapTLBAll` and `osMapTLBRdb` exist, and the game never maps pages itself (`osMapTLBRdb` is called once from `osInitialize`). |
| Interrupts | `os_internal_disable_int` / `os_internal_restore_int` become scheduler-level critical sections. `osSetIntMask` and `osGetIntMask` combine Status bits 8–15, the MI mask and the global mask word `0x80006880`. |
| Overlays | `overlay_load(romStart, romEnd, linkStart, linkEnd, dst)` loads, relocates, zeroes BSS and flushes the caches; see `overlays.md`. |

## Not present

Seventeen SDK routines have no counterpart in the binary: EEPROM (`osEepromProbe`, `osEepromRead`, `osEepromWrite`, `osEepromLongRead`, `osEepromLongWrite`), FlashRAM (`osFlashInit`, `osFlashReadId`, `osFlashReadStatus`, `osFlashClearStatus`, `osFlashAllErase`, `osFlashSectorErase`, `osFlashWriteBuffer`, `osFlashWriteArray`, `osFlashReadArray`) and TLB mapping (`osMapTLB`, `osUnmapTLB`, `osSetTLBASID`). Each has an absence predicate in `notPresent` (a check that must match no function of the image it names) and its reasoning below. There is also no stand-alone SRAM routine: save memory goes through `sram_transfer` and `sram_pi_transfer`.

## Reference

Generated by `tsx tools/analyze/os-doc.ts` from `data/os-signatures.json`; do not edit between the markers.

<!-- os-routines:begin -->

### Boot and start-up

#### `boot_entry` (boot, 0x80000400–0x80000434)

First code run after the IPL3 copy (ROM header entry address 0x80000400): clears the BSS (0x80006d50, 0x4a20 bytes), sets $sp to 0x80007740 and jumps to boot_main.

Evidence: 0x80000400: `lui t0,0x8000; addiu t0,t0,0x6d50; addiu t1,0,0x4a20`, loop storing zero doublewords until t1 reaches 0 (0x8000040c-0x80000418), `lui sp,0x8000; addiu sp,sp,0x7740`, `jr t2` with t2 = 0x80000498.

#### `boot_main` (boot, 0x80000498–0x80000594)

Boot main (jump target of boot_entry): registers the boot stack, probes the RAM size into 0x80000318, clears RAM beyond the boot image, calls osInitialize, initialises the cartridge ROM access, reads the cartridge region byte, creates the idle thread (id 1, entry boot_idle_thread, stack 0x80007320, priority 10) and starts it.

Evidence: 0x80000498: calls the stack registration helper 0x800019f0 twice, 0x80003ff0 (RAM size probe, result stored at 0x80000318 at 0x800004e4), 0x80000460 (clears from 0x8000b770 up to the RAM size), osInitialize (0x800004f0), 0x80005990 and 0x80001760 (PI domain set-up, handle stored at 0x80006730 at 0x80000508), 0x800013e0 (reads the cartridge header byte through osEPiReadIo), osCreateThread(0x80006d70, 1, 0x8000063c, 0, 0x80007320, 10) at 0x80000570 and osStartThread (0x8000057c).

#### `boot_main_thread` (boot, 0x800005a0–0x8000063c)

Entry of thread 3: starts the DMA manager, loads the main code file with rom_file_load(0x800116e0, 0xA89000, 0x1014F0), clears the code BSS and calls the main code entry point 0x800a2390.

Evidence: 0x800005a0: calls dma_manager_init (0x800005ac), osGetTime before and after the load (0x800005b4, 0x800005e4), rom_file_load with a0 = 0x800116e0, a1 = 0xA89000 (virtual ROM address), a2 = 0xB8A4F0 - 0xA89000 (0x800005bc-0x800005e0), the clear routine 0x80002ff0 with a0 = 0x80112bd0 and a1 = 0x80129e50 - 0x80112bd0 (0x800005f4-0x80000620), then `jal 0x800a2390` (0x80000624).

#### `boot_idle_thread` (boot, 0x8000063c–0x800007c8)

Entry of thread 1: selects the video mode for the TV type, blanks the screen, creates the PI manager, creates thread 3 (entry boot_main_thread, stack 0x80008170.., priority 10) and starts it, then lowers its own priority to 0 and spins.

Evidence: 0x8000063c: osViSetMode / osViSetSpecialFeatures / osViSetXScale / osViSetYScale through 0x800007e0, osViBlack(1) (0x80000718), osViSwapBuffer(0x803da80) (0x80000720), osCreatePiManager(150, queue, buffer, 50) (0x8000073c), stack registration 0x800019f0, osCreateThread(0x80007740, 3, 0x800005a0, arg, stack, 10) (0x800007a0), osStartThread (0x800007ac), osSetThreadPri(0, 0) (0x800007b8) and the infinite loop `beq 0,0` at 0x800007c0.

#### `code_entry` (code, 0x800a2390–0x800a273c)

Entry point of the main code file, called by boot_main_thread after the file was loaded and its BSS cleared.

Evidence: 0x800a2390: the target of `jal 0x800a2390` at 0x80000624 in boot_main_thread, the only caller.

### Interrupt mask, Status and Cause

#### `os_internal_set_sr` (boot, 0x80003590–0x800035a0)

Writes COP0 Status from $a0.

Evidence: 0x80003590: mtc0 $a0,$12; nop; jr ra.

#### `os_internal_get_sr` (boot, 0x800035a0–0x800035ac)

Returns COP0 Status.

Evidence: 0x800035a0: mfc0 $v0,$12; jr ra.

#### `osSetIntMask` (boot, 0x80003e20–0x80003ec0)

Replaces the interrupt-mask bits of Status (bits 8-15) and of the MI interrupt mask register from $a0, combined with the global interrupt mask; returns the previous combined mask.

Evidence: 0x80003e20: mfc0 $12 (0x80003e20), reads MI_INTR_MASK at 0xA430000C (0x80003e48), the global mask word 0x80006880, builds the return value from both, writes Status back with mtc0 $12 and updates the MI mask. 40 instructions, no calls.

#### `os_internal_set_global_int_mask` (boot, 0x80004f10–0x80004f5c)

ORs $a0 into the global interrupt-mask word at 0x80006880 inside a disable/restore pair.

Evidence: 0x80004f10: os_internal_disable_int; lw 0x80006880; or with a0 (0x80004f38); sw back; os_internal_restore_int.

#### `os_internal_reset_global_int_mask` (boot, 0x80005280–0x800052d8)

Clears the bits of $a0 (except bits 0 and 10) from the global interrupt-mask word at 0x80006880 inside a disable/restore pair.

Evidence: 0x80005280: os_internal_disable_int; `addiu at,0,-1026; and t8,t7,at` (0x800052a0-0x800052a4) keeps all but bits 0 and 10 of the argument; nor, and with the word at 0x80006880, store back (0x800052b8); os_internal_restore_int.

#### `os_internal_disable_int` (boot, 0x800052e0–0x80005350)

Clears the interrupt-enable bit (bit 0) of COP0 Status and returns the previous value of that bit; also merges the global interrupt-mask word into Status.

Evidence: mfc0 $12 at 0x800052f0, `addiu at,0,-2; and` clears bit 0, mtc0 $12 at 0x800052fc, `andi v0,t0,1` returns the old bit (0x80005300). Reads the word at 0x80006880 (global interrupt mask) before and after. Called by every thread, message and timer routine around their critical sections.

#### `os_internal_restore_int` (boot, 0x80005350–0x8000536c)

ORs its argument back into COP0 Status (re-enables interrupts when the argument is the bit returned by os_internal_disable_int).

Evidence: Seven instructions at 0x80005350: mfc0 t0,$12; or t0,t0,a0; mtc0 t0,$12; nops; jr ra. Always called with the value os_internal_disable_int returned (0x80003190/0x800031b8 in thread creation).

#### `os_internal_set_fpc_csr` (boot, 0x80005af0–0x80005b00)

Writes the FPU control/status register (FCR31) from $a0 and returns the old value.

Evidence: 0x80005af0: cfc1 $v0,$31; ctc1 $a0,$31; jr ra.

#### `os_internal_get_fpc_csr` (boot, 0x80005b00–0x80005b0c)

Returns the FPU control/status register (FCR31).

Evidence: 0x80005b00: cfc1 $v0,$31; jr ra.

#### `os_internal_get_cause` (boot, 0x80005c10–0x80005c1c)

Returns COP0 Cause.

Evidence: 0x80005c10: mfc0 $v0,$13; jr ra.

#### `osGetIntMask` (code, 0x800cfbe0–0x800cfc40)

Returns the current interrupt mask: Status bits (0xff01) combined with the MI interrupt mask and the global mask word 0x80006880.

Evidence: 0x800cfbe0: mfc0 $12, `andi v0,v0,0xff01` (0x800cfbe4), reads MI_INTR_MASK 0xA430000C and 0x80006880; no COP0 writes, no calls.

### Exception handling

#### `os_internal_exception_vector` (boot, 0x800025a0–0x800025b0)

Four-instruction stub copied to the CPU exception vectors; loads the address of the exception handler into $k0 and jumps to it.

Evidence: 0x800025a0: lui k0,0x8000; addiu k0,k0,0x25b0; jr k0 (the target is os_internal_exception). osInitialize copies these words to 0x80000000, 0x80000080, 0x80000100 and 0x80000180.

#### `os_internal_exception` (boot, 0x800025b0–0x80002ad4)

General exception handler: saves the interrupted thread's registers into its OSThread context, reads Cause (mfc0 $13) and EPC, dispatches on the exception code and on the pending interrupt lines (count/compare, software interrupts, SP, SI, AI, VI, PI, DP through MI_INTR, the cartridge line through the hardware-interrupt table, pre-NMI), sends the event messages registered with osSetEventMesg and finishes in os_internal_dispatch_thread.

Evidence: 0x800025b0: 342 instructions. Saves $at,$v0-$v1,$a0-$a3,$t0-$t9,$s0-$s7,$gp,$sp,$fp,$ra,HI,LO into the running thread and Status at +0x118, EPC at +0x11c (mfc0 $14 at 0x80002714), Cause at +0x120 (mfc0 $13 at 0x80002774); FPU registers when the thread flag +0x18 is set (0x8000271c-0x80002770). Exception code = Cause & 0x7c: 0x24 (break) -> 0x80002a40, 0x2c (coprocessor unusable) -> 0x80002b88, 0 (interrupt) -> pending-line loop at 0x800027b0 with a table jump (`jr t2` at 0x800027e0); any other code stops and faults the thread (0x80002aa4). Interrupt lines are acknowledged by writing SP_STATUS 0xA4040010 (0x8008), VI_CURRENT 0xA4400010, AI_LEN 0xA450000C, SI_STATUS 0xA4800018, PI_STATUS 0xA4600010 (2) and MI_MODE 0xA4300000 (0x800), each followed by a call to 0x80002ad4 with an event index. Ends with `j 0x80002d14` (os_internal_dispatch_thread) at 0x80002a84, 0x80002a9c and 0x80002acc.

#### `os_internal_exception_send_event` (boot, 0x80002ad4–0x80002b88)

Part of the exception handler: given an event index in $a0, sends the message registered for that event (table of {queue, message} pairs at 0x8000a410) to its queue if the queue has room, and wakes the first thread waiting on it.

Evidence: 0x80002ad4: table base 0x8000a410 plus a0 (0x80002ad8), loads queue->validCount (+8) and msgCount (+16), computes (first+validCount) mod msgCount with div (0x80002b0c), stores the message, increments validCount, pops a waiting thread with the pop routine at 0x80002d04 and enqueues it on the run queue (0x80002cbc); returns with `jr s2` (the caller saved ra in $s2 inside the handler, 0x80002ae4).

### Threads

#### `osStopThread` (boot, 0x800020d0–0x80002190)

Stops the thread in $a0, or the running thread when $a0 is 0: a running thread (state 4) becomes stopped and yields; a runnable (2) or waiting (8) thread is unlinked from its queue and becomes stopped.

Evidence: 0x800020d0: a0==0 gives state 4 (0x800020f4-0x800020fc), otherwise state = thread +0x10; switch on 2, 4, 8 (0x80002110-0x80002124); state 4: `sh 1,16(running)` then os_internal_enqueue_and_yield(0) (0x8000213c-0x80002148); states 2 and 8: `sh 1,16(thread)` then os_internal_dequeue_thread(thread->queue (+8), thread) (0x80002158-0x80002168).

#### `os_internal_enqueue_and_yield` (boot, 0x80002bbc–0x80002cbc)

Saves the running thread's context (Status|2, resume PC = $ra, callee-saved registers, FPU state when the thread uses it), enqueues the thread on the queue in $a0 when that is non-null, and dispatches the next runnable thread.

Evidence: 0x80002bbc: loads the running thread from 0x80006860, mfc0 $12 | 2 stored at +0x118 (0x80002bc4-0x80002bd0), $s0-$s7,$gp,$sp,$fp,$ra at +0x98-+0x100, $ra also as resume PC at +0x11c (0x80002c08), cfc1 $31 and $f20-$f30 saved when thread +0x18 is non-zero (0x80002c04-0x80002c28), folds the global interrupt mask 0x80006880 and MI_INTR_MASK 0xA430000C into +0x118 and +0x128 (0x80002c2c-0x80002ca8); `beq a0,0` skips the enqueue (0x80002ca4), otherwise calls 0x80002cbc; ends with `j 0x80002d14`.

#### `os_internal_enqueue_thread` (boot, 0x80002cbc–0x80002d04)

Inserts the thread in $a1 into the linked queue headed at *$a0, ordered by descending priority (field +4), and records the queue in thread +8.

Evidence: 0x80002cbc: walks nodes comparing the priority at +4 with `slt` (0x80002ccc, 0x80002ce4) and stops at the first node of lower priority; links the thread in (sw at 0x80002cf4/0x80002cf8) and stores the queue address into thread +8 (0x80002d00). Called by os_internal_enqueue_and_yield (0x80002cac) and osStartThread (0x8000622c, 0x80006270).

#### `os_internal_pop_thread` (boot, 0x80002d04–0x80002d14)

Removes and returns the first thread of the queue at *$a0.

Evidence: 0x80002d04: lw v0,0(a0); lw t9,0(v0); jr ra; sw t9,0(a0) in the delay slot: head = *q; *q = head->next; return head.

#### `os_internal_dispatch_thread` (boot, 0x80002d14–0x80002e90)

Pops the highest-priority runnable thread from the run queue (0x80006858), marks it running (state 4) and records it at 0x80006860, loads its saved Status/EPC/registers and returns to it with eret; when the queue is empty it installs the idle-thread context.

Evidence: 0x80002d14: calls os_internal_pop_thread on the queue at 0x80006858 (0x80002d18), mtc0 $12 and $14 write Status and EPC from the thread context, eret at the end, reads/writes MI_INTR_MASK (0xA430000C) to restore the thread's interrupt mask. The only function with eret.

#### `os_internal_dequeue_thread` (boot, 0x80002ea0–0x80002ee0)

Unlinks the thread in $a1 from the queue whose head pointer is at $a0.

Evidence: 0x80002ea0: walks `p = *q` comparing against $a1 and relinks `prev->next = a1->next` (0x80002ec4 sw t6,0(a2)); one loop, no calls.

#### `osDestroyThread` (boot, 0x80002ee0–0x80002fe4)

Destroys the thread in $a0 (or the running thread when 0): removes it from the queue it waits on (unless stopped) and from the all-threads list at 0x8000685c, and dispatches when it was the running thread.

Evidence: 0x80002ee0: os_internal_disable_int; a0==0 selects the running thread 0x80006860 (0x80002f0c); state != 1 -> os_internal_dequeue_thread(thread->queue, thread) (0x80002f20-0x80002f34); unlinks it from the list at 0x8000685c by walking the +0xc links (0x80002f3c-0x80002fa0; the walk ends at a node with priority -1, 0x80002f68); when it is the running thread calls os_internal_dispatch_thread (0x80002fbc); os_internal_restore_int. Also the target of the exit stub 0x80002e90.

#### `osCreateThread` (boot, 0x80003090–0x800031d4)

Initialises the OSThread in a0: id a1 at +0x14, priority (6th argument) at +4, entry a2 as resume PC at +0x11c, argument a3 in the saved $a0 slot (+0x38/+0x3c), stack top (5th argument) minus 16 as saved $sp (+0xf0/+0xf4), the thread-exit stub 0x80002e90 as saved $ra (+0x100/+0x104), initial Status 0xff03 (+0x118), interrupt mask 0x3f (+0x128), initial FPCSR 0x01000800 (+0x12c), state 1 (stopped); links the thread into the all-threads list at 0x8000685c.

Evidence: 0x80003090: `sw` of a1 at +0x14 (0x800030b4), of 60(sp) (the priority) at +4 (0x800030c0), of a2 at +0x11c (0x800030dc), of a3 sign-extended at +0x38/+0x3c (0x800030f0-0x800030f4), of stack-16 at +0xf0/+0xf4 (0x80003118/0x8000311c), of the constant 0x80002e90 at +0x100/+0x104 (0x80003124-0x80003134), Status 0xff03 (0x80003148-0x8000314c), 0x3f at +0x128 (0x80003164), 0x01000800 at +0x12c (0x80003170-0x80003174), state `sh 1,16` (0x80003188) and `sh 0,18` (0x80003194); then os_internal_disable_int (0x80003190), thread->next(+0xc) = *0x8000685c, *0x8000685c = thread (0x800031ac-0x800031bc), os_internal_restore_int. Called by the boot main at 0x80000570 with priority 10.

#### `osGetThreadId` (boot, 0x80003e00–0x80003e18)

Returns the id field (+0x14) of the thread in $a0, or of the running thread when $a0 is 0.

Evidence: 0x80003e00: `bne a0,0; lw a0,0x6860(0x8000)` (running thread); `lw v0,20(a0)`.

#### `osSetThreadPri` (boot, 0x800045e0–0x800046c0)

Sets the priority (a1) of thread a0 (0 = running thread) and re-sorts it in its queue; yields when the running thread no longer has the highest priority.

Evidence: 0x800045e0: os_internal_disable_int; priority stored at thread +4; the thread is dequeued and re-enqueued in its queue; os_internal_enqueue_and_yield on the run queue when needed; os_internal_restore_int. Calls os_internal_dequeue_thread, os_internal_enqueue_thread and os_internal_enqueue_and_yield.

#### `osYieldThread` (boot, 0x80005bc0–0x80005c0c)

Sets the running thread runnable (state 2) and re-queues it behind equal-priority threads.

Evidence: 0x80005bc0: os_internal_disable_int; `sh 2,16(running)` (0x80005bd8-0x80005bec); os_internal_enqueue_and_yield(0x80006858); os_internal_restore_int.

#### `osStartThread` (boot, 0x800061e0–0x80006330)

Starts a thread: a stopped thread (state 1) with no wait queue (or already on the run queue) becomes runnable (state 2) on the run queue 0x80006858; a thread in state 8 is also made runnable; afterwards dispatches when nothing is running, or yields when the head of the run queue outranks the running thread.

Evidence: 0x800061e0: state (+0x10) tested against 1 (0x80006208) and 8 (0x8000620c); `sh 2,16` + os_internal_enqueue_thread(0x80006858, thread) at 0x80006224-0x8000622c and 0x80006268-0x80006270; a thread whose queue (+8) is another queue is set to state 8, re-enqueued there and the queue head is popped (os_internal_pop_thread at 0x800062a0) onto the run queue; then reads the running thread 0x80006860: none -> os_internal_dispatch_thread (0x800062cc), else compares priorities (+4) with slt (0x800062f4) and calls os_internal_enqueue_and_yield(0x80006858) after setting the running thread to state 2 (0x80006300-0x8000630c).

### Message queues

#### `osSendMesg` (boot, 0x80001f80–0x800020cc)

Appends message a1 to queue a0. When the queue is full: returns -1 for a2==0, blocks the caller on the queue's fullqueue (+4) for a2==1 (OS_MESG_BLOCK) and retries. After storing, wakes the first thread waiting in mtqueue (+0).

Evidence: 0x80001f80: compares validCount (+8) with msgCount (+0x10) (0x80001fac); blocking path sets running-thread state 8 and calls os_internal_enqueue_and_yield with queue+4 (`addiu a0,a0,4` at 0x80001fe8); stores at msg[(first+validCount) mod msgCount] with div (0x80002038), validCount++ (0x80002078), pops a waiting receiver and calls osStartThread (0x800020a0).

#### `osRecvMesg` (boot, 0x800021a0–0x800022d8)

Removes the oldest message from queue a0 into *a1 (if a1 is non-null); when empty, returns -1 for a2==0 or blocks the caller on the queue's mtqueue for a2==1. After removing, wakes the first thread waiting in fullqueue (+4).

Evidence: 0x800021a0: validCount==0 test (0x800021c8); blocking path calls os_internal_enqueue_and_yield with queue (0x80002200); copies msg[first] to *a1 (0x80002238-0x8000223c); first=(first+1) mod msgCount with div (0x80002250), validCount-- (0x8000228c); pops a sender from queue+4 (`addiu a0,t9,4` at 0x800022a8) and restarts it.

#### `osCreateMesgQueue` (boot, 0x80004380–0x800043ac)

Initialises an OSMesgQueue (a0) over the buffer a1 with capacity a2: both wait lists point at the empty-list sentinel 0x80006850, valid count 0, first 0.

Evidence: 0x80004380: stores the address 0x80006850 at +0 and +4, zero at +8 and +0xc, a2 at +0x10 (msgCount) and a1 at +0x14 (message buffer); 11 instructions, no calls.

#### `osJamMesg` (boot, 0x80004490–0x800045e0)

Inserts message a1 at the front of queue a0 (first = (first+msgCount-1) mod msgCount), blocking like osSendMesg when the queue is full and waking a waiting receiver.

Evidence: 0x80004490: same full-queue test and blocking structure as osSendMesg, but writes the message at the decremented `first` index; called by osEPiStartDma (0x80004220) to put a DMA request at the head of the PI command queue.

### Events

#### `osSetEventMesg` (boot, 0x80004110–0x800041c4)

Registers queue a1 and message a2 for event a0 in the table at 0x8000a410 (8 bytes per event); event 14 additionally touches the global interrupt mask.

Evidence: 0x80004110: os_internal_disable_int; index*8 added to 0x8000a410 (0x80004130-0x80004140); stores queue and message (0x80004148, 0x8000415c); compares the event with 14 (`addiu at,0,14` at 0x80004154); calls os_internal_set_global_int_mask for it; os_internal_restore_int.

#### `os_internal_set_hw_intr_routine` (boot, 0x800064c0–0x8000652c)

Installs handler a1 and stack pointer a2 for hardware interrupt a0 in the table at 0x80006620 (8 bytes per entry).

Evidence: 0x800064c0: os_internal_disable_int; `sll t8,a0,3` and stores a1/a2 into 0x80006620+index*8 (0x800064ec-0x80006508); os_internal_restore_int. The exception handler loads the table entry at 0x80002824 and calls it with jalr (0x8000283c).

### Timers and counters

#### `osGetTime` (boot, 0x80004a70–0x80004af4)

Returns the 64-bit CPU cycle count: the saved total at 0x8000a4b0/0x8000a4b4 plus the cycles elapsed since the count saved at 0x8000a4b8.

Evidence: 0x80004a70: os_internal_disable_int; osGetCount; subtracts the saved count (0x80004aa8), reads the total (0x80004a90-0x80004aa4); os_internal_restore_int; 64-bit addition with carry via sltu (0x80004ad0-0x80004af0).

#### `os_internal_timer_services_init` (boot, 0x80004b00–0x80004b8c)

Clears the 64-bit total time, the saved count and the timer list and points the list head at itself.

Evidence: 0x80004b00: stores zeros to 0x8000a4b0-0x8000a4bc (total hi/lo, saved count, armed count) and initialises the list words at 0x800068d0; no calls. Called by osCreateViManager (0x80005ee4).

#### `os_internal_timer_interrupt` (boot, 0x80004b8c–0x80004d04)

Compare-interrupt handler of the timer list: runs expired timers (sending each timer's message to its queue), re-inserts periodic ones and re-arms Compare.

Evidence: 0x80004b8c: calls osGetCount, osSendMesg, os_internal_insert_timer, os_internal_set_timer_intr and os_internal_set_compare; reads the list head at 0x800068d0; called from os_internal_vi_mgr_main.

#### `os_internal_set_timer_intr` (boot, 0x80004d04–0x80004d78)

Programs COP0 Compare for now + the 64-bit interval in a0:a1 and records the count at which it was armed (0x8000a4c0).

Evidence: 0x80004d04: os_internal_disable_int; osGetCount stored at 0x8000a4c0 (0x80004d1c-0x80004d24); count + interval (0x80004d3c-0x80004d54); os_internal_set_compare (0x80004d58); os_internal_restore_int.

#### `os_internal_insert_timer` (boot, 0x80004d78–0x80004f00)

Inserts an OSTimer into the list of pending timers headed at 0x800068d0, ordered by absolute expiry (64-bit compares).

Evidence: 0x80004d78: os_internal_disable_int/os_internal_restore_int around two loops over the list; reads the head at 0x800068d0.

#### `osGetCount` (boot, 0x80004f00–0x80004f0c)

Returns the COP0 Count register (CPU cycle counter at half the CPU clock).

Evidence: 0x80004f00: mfc0 $v0,$9; jr ra. Used by the time-keeping routines to extend the 32-bit counter to 64 bits.

#### `os_internal_set_compare` (boot, 0x80004f60–0x80004f6c)

Writes COP0 Compare from $a0 (arms the timer interrupt).

Evidence: 0x80004f60: mtc0 $a0,$11; jr ra.

#### `osSetTimer` (boot, 0x80005d80–0x80005e54)

Starts timer a0 for the 64-bit interval a2:a3 (period a4:a5 when non-zero), sending its message to its queue on expiry.

Evidence: 0x80005d80: 53 instructions; calls os_internal_insert_timer and os_internal_set_timer_intr only.

#### `osStopTimer` (code, 0x800d1540–0x800d1628)

Cancels the OSTimer in a0: returns -1 when it is not in the list; otherwise adds its remaining interval to the next timer, unlinks it and, when the list became empty, writes zero to COP0 Compare.

Evidence: 0x800d1540: returns -1 when `*timer == 0` (0x800d1554-0x800d1564); os_internal_disable_int; compares the successor with the list head 0x800068d0 (0x800d1578-0x800d1584); 64-bit add into the successor (0x800d1590-0x800d15b8); unlinks (0x800d15c4-0x800d15dc); os_internal_set_compare(0) when the list is empty (0x800d15f4-0x800d1604); os_internal_restore_int.

### PI bus and cartridge access

#### `osPiGetAccess` (boot, 0x80001f10–0x80001f54)

Blocks until the PI bus is free: on first use creates the access queue (0x80008f78, one message), then receives from it.

Evidence: 0x80001f10: tests the flag at 0x800067c0 (0x80001f14-0x80001f20), calls 0x80001ec0 when clear, then osRecvMesg(0x80008f78, &msg, 1) (0x80001f30-0x80001f40).

#### `osPiRelAccess` (boot, 0x80001f54–0x80001f80)

Releases the PI bus by sending a message to the access queue.

Evidence: 0x80001f54: osSendMesg(0x80008f78, 0, 0) (0x80001f5c-0x80001f68).

#### `osCreatePiManager` (boot, 0x80003670–0x800037e0)

Creates the PI manager: the access queue, the command and reply queues, the PI event registration and the PI manager thread (entry os_internal_dev_mgr_main), then starts it.

Evidence: 0x80003670: tests the flag at 0x80006890 (the flag osPiGetCmdQueue reads) (0x80003678-0x80003690); calls the access-queue creator 0x80001ec0, osCreateMesgQueue, osSetEventMesg, osCreateThread with entry 0x800037e0, osSetThreadPri, os_internal_disable_int/os_internal_restore_int, osStartThread.

#### `os_internal_dev_mgr_main` (boot, 0x800037e0–0x80003bb8)

Body of the PI manager thread: loops receiving requests from the command queue, performs them with the raw PI routines, adjusts interrupt masks and replies on each request's queue.

Evidence: 0x800037e0: 245 instructions; loops around osRecvMesg (0x80003834) and osSendMesg; one table jump; calls os_internal_e_pi_raw_read_io, os_internal_e_pi_raw_write_io, os_internal_set_global_int_mask, os_internal_reset_global_int_mask and osYieldThread; touches PI_STATUS 0xA4600010.

#### `os_internal_pi_raw_start_dma` (boot, 0x80003bf0–0x80003cb8)

Starts one PI DMA transfer: waits for PI_STATUS idle, translates the RAM address, writes PI_DRAM_ADDR, PI_CART_ADDR (device address ORed with the ROM base word 0x80000308) and the length register selected by direction.

Evidence: 0x80003bf0: polls 0xA4600010 & 3 (0x80003c08-0x80003c28); calls osVirtualToPhysical (0x80003c2c); stores to 0xA4600000 (0x80003c40); reads 0x80000308 (0x80003c48); also writes 0xA4600004 and the length registers. No callers in the boot image.

#### `osEPiStartDma` (boot, 0x80004220–0x800042f4)

Posts one PI transfer request to the PI manager: a0 = OSPiHandle, a1 = request record, a2 = direction (0 reads the cartridge, non-zero writes it). Stores the handle at request +0x14, the request type 15 (a2 = 0) or 16 (a2 != 0) at +0, and sends the request to the PI command queue: with osJamMesg at the front when the request byte +2 equals 1, with osSendMesg otherwise. Returns -1 when the PI manager is not running.

Evidence: 0x80004220: returns -1 when the PI manager flag 0x80006890 is zero (0x80004224-0x80004248); the store `sw a0,20(a1)` at 0x80004258 stores the handle; the halfword at +0 is 15 when a2 is zero (0x80004268-0x80004274) and 16 otherwise (0x80004278-0x80004280); the byte at +2 selects osJamMesg (0x800042ac) when it is 1, osSendMesg (0x800042d0) otherwise; the queue comes from osPiGetCmdQueue (0x80004298, 0x800042bc). Callers pass the handle first: dma_copy_from_rom at 0x80000a4c (a0 = word at 0x80006730, a1 = request on its stack, a2 = 0) and 0x80091adc.

#### `os_internal_e_pi_raw_read_io` (boot, 0x800046e0–0x8000483c)

Reads one 32-bit word from device address a1 through the PI bus into *a2, after programming the domain timing registers from OSPiHandle a0.

Evidence: 0x800046e0: waits on PI_STATUS 0xA4600010 (0x800046e8-0x80004708); domain registers 0xA4600014-0xA4600030 are reprogrammed when the handle differs from the last one (0x80004710-0x80004818); `or t4,t3,0xa0000000; lw t5,0(t4); sw t5,0(a2)` (0x80004828-0x80004838).

#### `os_internal_e_pi_raw_start_dma` (boot, 0x80004890–0x80004a70)

Starts a PI DMA like os_internal_pi_raw_start_dma, for an OSPiHandle (a0): first reprograms the domain timing registers from the handle when they differ from the last handle used for the domain.

Evidence: 0x80004890: waits on PI_STATUS (0x800048a8-0x800048c8); reads handle fields +4..+9 and compares with the previous handle; writes PI domain registers 0xA4600014-0xA4600030 and the DRAM/CART/length registers 0xA4600000-0xA460000C; one call (osVirtualToPhysical). No callers in the boot image.

#### `osPiGetCmdQueue` (boot, 0x800057b0–0x800057d8)

Returns the PI manager's command queue (0x80006898) or 0 when the PI manager is not running (flag at 0x80006890).

Evidence: 0x800057b0: `lw t6,0x6890(0x8000); bne t6,0; return 0 else lw v0,0x6898`.

#### `osEPiReadIo` (boot, 0x800057e0–0x80005824)

osPiGetAccess; os_internal_e_pi_raw_read_io; osPiRelAccess.

Evidence: 0x800057e0 calls osPiGetAccess (0x80001f10), the raw read os_internal_e_pi_raw_read_io (0x800046e0, at 0x80005800) and osPiRelAccess (0x80001f54); called by the boot code at 0x800013f4 to read the cartridge header.

#### `osEPiWriteIo` (boot, 0x80005b10–0x80005b54)

osPiGetAccess; os_internal_e_pi_raw_write_io; osPiRelAccess.

Evidence: 0x80005b10 calls osPiGetAccess (0x80001f10), the raw write os_internal_e_pi_raw_write_io (0x80005c20, at 0x80005b30) and osPiRelAccess (0x80001f54).

#### `os_internal_e_pi_raw_write_io` (boot, 0x80005c20–0x80005d78)

Writes the 32-bit value a2 to device address a1 through the PI bus, after programming the domain timing registers from OSPiHandle a0.

Evidence: 0x80005c20: same set-up as os_internal_e_pi_raw_read_io (0x80005c20-0x80005d5c), then `or t4,t3,0xa0000000; jr ra; sw a2,0(t4)` (0x80005d68-0x80005d74).

#### `pi_handle_create` (code, 0x800919b0–0x80091a88)

Creates or updates a PI device handle (OSPiHandle at 0x800fa010) for a cartridge address range: stores the type, the domain timing bytes (latency, pulse width, page size, release) and the KSEG1 base address (a0 | 0xA0000000), clears the 0x60-byte transfer area and links the handle into the handle list at 0x800068ac.

Evidence: 0x800919b0: compares a0 | 0xa0000000 with the stored base at +0xc (0x800919e0-0x800919ec), stores type at +4, bytes at +5..+9, base at +0xc and a word at +0x10, bzero of 0x60 bytes at 0x800fa024 (0x80091a1c-0x80091a30), os_internal_disable_int, then updates the list head 0x800068ac (0x80091a40-0x80091a4c).

### ROM file loading

#### `dma_copy_from_rom` (boot, 0x8000099c–0x80000b20)

Copies a range of the ROM (a0 = ROM address, a1 = RAM address, a2 = size) with PI DMA in chunks, waiting for each, and invalidates the instruction and data caches over the destination.

Evidence: 0x8000099c: osCreateMesgQueue for the reply, repeated osEPiStartDma + osRecvMesg for each chunk, then osInvalICache and osInvalDCache on the destination; 97 instructions with one loop.

#### `dma_serve_request` (boot, 0x80000c4c–0x80000de8)

Serves one file request: finds the file-table record containing the virtual ROM address, then copies it with dma_copy_from_rom when it is stored uncompressed or reads and decompresses it with yaz0_decode when it is compressed; raises the fault routine when the address is not in the table.

Evidence: 0x80000c4c: walks the table copied to 0x8000b770 (0x80000c58 onwards), calls dma_copy_from_rom (0x80000d00 area) and 0x80001394 (decompression set-up that ends in yaz0_decode), osSetThreadPri around the work, and 0x800afdf4 (fault) on a missing record; 103 instructions.

#### `dma_manager_thread` (boot, 0x80000de8–0x80000e68)

Body of the DMA manager thread: receives requests from its queue, serves each with dma_serve_request and sends the request back to the reply queue it names.

Evidence: 0x80000de8: osRecvMesg (blocking), call to 0x80000c4c with the request, osSendMesg of the finished request to the reply queue stored in it.

#### `dma_request_send` (boot, 0x80000e68–0x80000f30)

Builds a DMA request record (virtual ROM address, RAM address, size, reply queue) and posts it to the DMA manager queue with osSendMesg; when the hook object at 0x8011f240 provides a handler (+0x74) it calls that instead.

Evidence: 0x80000e68: loads the pointer at 0x8011f240 (0x80000e84), jalr through its +0x74 field (0x80000ec0), otherwise stores the arguments into the request (0x80000ee4-0x80000f14) and calls osSendMesg (0x80000f10).

#### `rom_file_load` (boot, 0x80000f30–0x80000fac)

Synchronous file read: rom_file_load(a0 = RAM destination, a1 = virtual ROM address, a2 = size); posts a request to the DMA manager with a local reply queue and waits for the reply.

Evidence: 0x80000f30: osCreateMesgQueue on the stack (0x80000f4c), dma_request_send with the three arguments and the queue (0x80000f70), then osRecvMesg(queue, 0, 1) (0x80000f90). Called by boot_main_thread with the main code file and by 23 sites of the main code file.

#### `dma_manager_init` (boot, 0x80000fac–0x80001094)

Copies the file table (ROM 0x7950-0xD8C0) into RAM at 0x8000b770 with dma_copy_from_rom, checks its first record, creates the DMA manager message queues and thread (entry dma_manager_thread) and starts it.

Evidence: 0x80000fac: dma_copy_from_rom(0x7950, 0x8000b770, 0xD8C0-0x7950) at 0x80000fd0, compares the word at 0x8000b774 with 0x1060 (0x80000fdc-0x80000fe8; the virtual end of the first file), calls the fault routine 0x800afdf4 when different, then osCreateMesgQueue, osCreateThread and osStartThread.

#### `yaz0_decode` (boot, 0x8000122c–0x80001394)

Decodes a Yaz0 stream: reads the 16-byte header (decompressed size at +4), then flag-driven literals and back references (12-bit distance + 1, 4-bit length + 2, or a third length byte + 0x12) until the output reaches the size.

Evidence: 0x8000122c: `lw t6,4(s1); addiu s1,s1,16` (0x80001250-0x80001260); flag test `andi t9,a3,0x80` (0x80001278, 0x800012b0); distance `andi t2,v1,0xf; sll 8; or` (0x800012dc-0x800012e8); length `sra a1,v1,4`, `addiu v1,v1,18` (0x80001300) or `addiu v1,a1,2` (0x80001304); byte-wise copy loops (0x80001318-0x80001364).

### Save memory

#### `sram_pi_transfer` (code, 0x80091a88–0x80091b14)

One synchronous transfer between RDRAM and the cartridge save memory through the save-memory PI handle: sram_pi_transfer(a0 = RAM address, a1 = size, a2 = direction, 0 reads the cartridge, 1 writes it).

Evidence: 0x80091a88: creates a one-message reply queue with osCreateMesgQueue (0x80091aa8), stores a0 and a1 into the request record at 0x8010a08c/0x8010a094 (0x80091ac0, 0x80091ac8), osWritebackDCache over the buffer (0x80091ac4), osEPiStartDma on the handle 0x8010a010 with the direction a2 (0x80091adc), osRecvMesg on the reply queue (0x80091af0) and osInvalDCache over the buffer (0x80091afc). Single caller 0x80091b5c.

#### `sram_transfer` (code, 0x80091b14–0x80091b74)

Reads or writes save memory: sram_transfer(a0 = cartridge address, a1 = RAM address, a2 = size, a3 = direction 0 read / 1 write). Fills the save-memory PI handle for that address (type 3, latency 5, pulse width 13, page size 2, release 12) with pi_handle_create, then runs sram_pi_transfer.

Evidence: 0x80091b14: constants 13, 2, 12 stored as stack arguments (0x80091b28-0x80091b38) and 3, 1, 5 in a1-a3 (0x80091b40-0x80091b48) before pi_handle_create (0x80091b4c); then `jal 0x80091a88` with a1, a2, a3 shifted down (0x80091b54-0x80091b5c). 12 callers in the save-handling code 0x80090c80-0x80091894 pass a0 = 0x08000000 + a table offset (`lui at,0x800` at 0x80090c64 / 0x80090d4c): reads use a3 = 0 (0x80090d58 reads 0x8000 bytes into a buffer cleared with 0x80002ff0), writes use a3 = 1 with size 0x1450 (0x80090c74-0x80090c7c). The 0x08000000 base is the cartridge SRAM window, so saves go through the PI like any cartridge read.

### Address translation

#### `osVirtualToPhysical` (boot, 0x80003cc0–0x80003d3c)

Converts a virtual address to a physical address: KSEG0/KSEG1 by masking with 0x1fffffff, TLB-mapped addresses through os_internal_probe_tlb; returns -1 when unmapped.

Evidence: 0x80003cc0: compares with 0x80000000, 0xa0000000, 0xc0000000 (0x80003cd0-0x80003d0c) and masks with 0x1fffffff; the other case calls 0x80003f30.

### TLB

#### `os_internal_probe_tlb` (boot, 0x80003f30–0x80003fe8)

Looks up virtual address a0 in the TLB (tlbp), reads the matching entry (tlbr) and returns the physical address, or -1 when there is no valid mapping.

Evidence: 0x80003f30: sets EntryHi (mtc0 $10) from the address and ASID, tlbp (0x80003f54), tests Index bit 31, tlbr (0x80003f74), reads PageMask ($5), EntryLo0/1 ($2/$3) and picks the half-page by the address bit.

#### `osUnmapTLBAll` (boot, 0x800041d0–0x80004214)

Invalidates all TLB entries except the wired one(s): writes an invalid EntryHi with tlbwi for indices 30 down to 0.

Evidence: 0x800041d0: `addiu t1,0,30` (0x800041d4); loop writing Index ($0), EntryLo0/1 = 0, EntryHi = 0x80000000 with tlbwi (0x800041f0) and decrementing until negative (bgez at 0x80004200).

#### `osMapTLBRdb` (boot, 0x80005b60–0x80005bb8)

Writes TLB entry 31 so that virtual 0xC0000000 maps to physical 0 (page mask 0), used for the debugger window.

Evidence: 0x80005b60: Index = 31 (0x80005b64-0x80005b68), PageMask = 0 (0x80005b6c), EntryHi = 0xC0000000 (0x80005b74-0x80005b78), EntryLo = (0x80000000>>6)|23 (0x80005b7c-0x80005b88), tlbwi.

#### `osMapTLB` — not present

Maps a TLB entry from arguments (not present).

Evidence: The only functions that use TLB instructions or write COP0 EntryHi are os_internal_probe_tlb (tlbp/tlbr), osUnmapTLBAll and osMapTLBRdb (tlbwi, called once at start-up from osInitialize); no function writes a TLB entry from arguments (osMapTLB), unmaps a single entry (osUnmapTLB) or sets the ASID (osSetTLBASID).

#### `osSetTLBASID` — not present

Sets the TLB ASID (not present).

Evidence: The only functions that use TLB instructions or write COP0 EntryHi are os_internal_probe_tlb (tlbp/tlbr), osUnmapTLBAll and osMapTLBRdb (tlbwi, called once at start-up from osInitialize); no function writes a TLB entry from arguments (osMapTLB), unmaps a single entry (osUnmapTLB) or sets the ASID (osSetTLBASID).

#### `osUnmapTLB` — not present

Invalidates one TLB entry (not present).

Evidence: The only functions that use TLB instructions or write COP0 EntryHi are os_internal_probe_tlb (tlbp/tlbr), osUnmapTLBAll and osMapTLBRdb (tlbwi, called once at start-up from osInitialize); no function writes a TLB entry from arguments (osMapTLB), unmaps a single entry (osUnmapTLB) or sets the ASID (osSetTLBASID).

### Cache

#### `osWritebackDCache` (boot, 0x800035b0–0x80003624)

Writes back (without invalidating) the data-cache lines covering [a0, a0+a1); sizes of 0x2000 or more write back the whole cache by index.

Evidence: 0x800035b0: `cache 0x19` (Hit_Writeback_D) in a 16-byte stepped loop (0x800035e8-0x800035f4); size compared with 0x2000 (0x800035b8); `cache 0x01` (Index_Writeback_Invalidate_D) over 0x80000000.. (0x8000360c).

#### `osInvalICache` (boot, 0x80004300–0x80004374)

Invalidates the instruction-cache lines covering [a0, a0+a1); sizes of 0x4000 or more use an index operation.

Evidence: 0x80004300: `cache 0x10` (Hit_Invalidate_I) in a 32-byte stepped loop (0x80004338-0x80004340), `cache 0x00` (Index_Invalidate_I) for large sizes; threshold 0x4000 (0x80004308).

#### `osInvalDCache` (boot, 0x800043b0–0x8000445c)

Invalidates the data-cache lines covering [a0, a0+a1), writing back partially covered edge lines first; sizes of 0x2000 or more use an index operation.

Evidence: 0x800043b0: `cache 0x15` (Hit_Writeback_Invalidate_D) at 0x800043ec, `cache 0x11` (Hit_Invalidate_D) and `cache 0x01` for large sizes; threshold 0x2000 (0x800043b8).

#### `osWritebackDCacheAll` (code, 0x800d6160–0x800d6188)

Writes back and invalidates the whole data cache by index (512 lines of 16 bytes from 0x80000000).

Evidence: 0x800d6160: `cache 0x01` (Index_Writeback_Invalidate_D) in a loop over 0x80000000..0x80000000+0x2000 (`addiu t2,0,0x2000`, step 16).

### Video interface

#### `osViGetNextFramebuffer` (boot, 0x80003630–0x80003670)

Returns the framebuffer address stored in the next VI context (+4).

Evidence: 0x80003630: os_internal_disable_int; `lw t6,0x6944(0x8000)` (next context); `lw t7,4(t6)`; os_internal_restore_int.

#### `osViBlack` (boot, 0x80003d40–0x80003db0)

Turns the video output black (a0 != 0) or back on by setting/clearing bit 0x20 in the next VI context's state.

Evidence: 0x80003d40: os_internal_disable_int; `ori 0x20` on `*(u16*)next` (0x80003d70) when a0 != 0 else `and ~0x20` (addiu at,0,-33 at 0x80003d84); os_internal_restore_int.

#### `osViSetMode` (boot, 0x80003ec0–0x80003f28)

Stores the OSViMode pointer a0 in the next VI context (+8), sets the context state to 1 and copies the mode's control word (mode +4) into the context (+0xc).

Evidence: 0x80003ec0: os_internal_disable_int; `sw a0,8(next)` (0x80003ee8); `sh 1,0(next)` (0x80003ef8); `lw t1,8(next); lw t2,4(t1); sw t2,12(next)` (0x80003f04-0x80003f10); os_internal_restore_int. `next` is the pointer at 0x80006944.

#### `osViSwapBuffer` (boot, 0x80004840–0x80004890)

Stores the framebuffer address a0 in the next VI context (+4) and sets the buffer-updated flag 0x10 in its state.

Evidence: 0x80004840: os_internal_disable_int; `sw a0,4(next)` (0x80004864); `ori 0x10` on the state halfword (0x80004870-0x80004874); os_internal_restore_int.

#### `os_internal_vi_init` (boot, 0x80005370–0x800054ac)

Initialises the two VI contexts at 0x800068e0 (0x60 bytes cleared), sets the current/next pointers 0x80006940/0x80006944 and selects the default VI mode and origin from the TV type.

Evidence: 0x80005370: clears 0x60 bytes at 0x800068e0 with 0x80002ff0 (0x80005378-0x80005384); stores the pointers 0x80006940/0x80006944 = base and base+0x30 (0x80005394-0x800053a0); state halfwords set to 1 (0x800053a8-0x800053bc); reads osTvType 0x80000300; VI_ORIGIN/VI_CURRENT accesses at 0xA4400000/0xA4400010; calls os_internal_vi_swap_context.

#### `os_internal_vi_swap_context` (boot, 0x800054b0–0x800057a8)

At retrace commits the next VI context to the VI registers and swaps current/next.

Evidence: 0x800054b0: writes the VI registers 0xA4400000-0xA4400034 (14 registers) conditioned on bits of the context state; reads the pointers 0x80006940/0x80006944.

#### `osViSetSpecialFeatures` (boot, 0x80005830–0x8000598c)

Edits the next VI context's control word (+0xc) from the feature bits in a0 and sets state bit 8.

Evidence: 0x80005830: os_internal_disable_int; tests bits of a0 with andi (first `andi t6,a0,1`) and sets or clears control bits (e.g. `ori t8,t7,8` at 0x80005864); os_internal_restore_int; 87 instructions.

#### `osCreateViManager` (boot, 0x80005ec0–0x80006040)

Creates the VI manager: its message queues, the timer services and VI contexts, registers the VI and counter events, creates and starts the VI manager thread (entry os_internal_vi_mgr_main) with temporarily changed priority.

Evidence: 0x80005ec0: tests/sets the init flag at 0x80006a50 (0x80005ec8-0x80005edc); calls os_internal_timer_services_init (0x80005ee4), osCreateMesgQueue, osSetEventMesg for the VI and counter events, os_internal_vi_init, osCreateThread with entry 0x80006040, osSetThreadPri around the set-up, os_internal_disable_int/os_internal_restore_int, osStartThread.

#### `os_internal_vi_mgr_main` (boot, 0x80006040–0x80006190)

Body of the VI manager thread: receives retrace and counter messages; on retrace swaps the VI contexts with os_internal_vi_swap_context, on the counter message runs os_internal_timer_interrupt, and forwards messages to registered clients.

Evidence: 0x80006040: calls osRecvMesg, os_internal_vi_get_current_context (0x8000606c), os_internal_vi_swap_context, os_internal_timer_interrupt, osGetCount and osSendMesg; three loops.

#### `os_internal_vi_get_current_context` (boot, 0x800061d0–0x800061dc)

Returns the pointer to the current VI context (word at 0x80006940).

Evidence: 0x800061d0: lui v0,0x8000; jr ra; lw v0,0x6940(v0).

#### `osViSetXScale` (boot, 0x80006330–0x80006388)

Stores float a0 as the horizontal scale of the next VI context (+0x24) and sets state bit 4.

Evidence: 0x80006330: `swc1 f4,36(next)` (0x80006358), `ori 4` on the state (0x80006368).

#### `osViSetYScale` (boot, 0x80006390–0x800064b8)

Stores float a0 as the vertical scale of the next VI context (+0x18), sets state bit 2 and recomputes the context's y-scale register value (+0x20) from the mode.

Evidence: 0x80006390: `swc1 f4,24(next)` (0x800063bc), `ori 2` on the state (0x800063cc); multiplies by the mode field masked with 0xfff (0x800063e4-0x80006408), converts back to an integer and stores it at +0x20 (0x80006498).

#### `osViSetEvent` (code, 0x800d36c0–0x800d372c)

Registers message queue a0 and message a1 with retrace count a2 in the next VI context, so the VI manager forwards each retrace to that queue.

Evidence: 0x800d36c0: os_internal_disable_int; `sw a0,16(next)` (0x800d36f0), `sw a1,20(next)` (0x800d3704), `sh a2,2(next)` (0x800d3714); os_internal_restore_int; `next` is the pointer at 0x80006944.

#### `osViGetCurrentFramebuffer` (code, 0x800d63b0–0x800d63f0)

Returns the framebuffer address of the current VI context (+4 of the structure at 0x80006940).

Evidence: 0x800d63b0: os_internal_disable_int; `lw t6,0x6940(0x8000)`; `lw t7,4(t6)`; os_internal_restore_int.

### RSP

#### `osSpTaskLoad` (code, 0x800d002c–0x800d01bc)

Loads an OSTask (a0) for the RSP: writes the task back from the data cache, converts its pointers to physical addresses (0x800cff10), then DMAs the microcode text into IMEM and the data into DMEM with os_internal_sp_raw_start_dma and sets the RSP program counter (a resumed, yielded task restores its saved state first).

Evidence: 0x800d002c: calls osWritebackDCache (0x800d0050), the task-copy/physical-address helper 0x800cff10, os_internal_sp_raw_start_dma (two or more times, loops), os_internal_sp_set_status and os_internal_sp_set_pc; 100 instructions, four loops.

#### `osSpTaskStartGo` (code, 0x800d01bc–0x800d01fc)

Starts the loaded RSP task: waits until the RSP DMA is idle, then clears the halt and broke bits (and interrupt-on-break handling) in SP_STATUS.

Evidence: 0x800d01bc: loop on os_internal_sp_device_busy then os_internal_sp_set_status; 16 instructions.

#### `os_internal_sp_raw_start_dma` (code, 0x800d0e40–0x800d0ec4)

Starts an RSP DMA: returns -1 while os_internal_sp_device_busy; otherwise writes SP_MEM_ADDR (0xA4040000) from a1, SP_DRAM_ADDR (0xA4040004) from the physical address of a2, and the length (a3-1) to SP_RD_LEN (0xA4040008) when a0 is 0 or SP_WR_LEN (0xA404000C) otherwise.

Evidence: 0x800d0e40: calls os_internal_sp_device_busy (0x800d0e4c) and osVirtualToPhysical (0x800d0e60); stores to 0xA4040000/04/08/0C.

#### `osSpTaskYield` (code, 0x800d0f80–0x800d0fa0)

Asks the running RSP task to yield by setting SP signal 0 (SP_STATUS write 0x400).

Evidence: 0x800d0f80: `addiu a0,0,0x400` (0x800d0f8c) then os_internal_sp_set_status.

#### `os_internal_sp_device_busy` (code, 0x800d2c60–0x800d2c8c)

Returns 1 while an RSP DMA or IO transfer is pending (SP_STATUS bits 0x1c), else 0.

Evidence: 0x800d2c60: reads SP_STATUS (0xA4040010) and masks with 0x1c (`andi t7,a0,0x1c` at 0x800d2c6c); no calls.

#### `osSpTaskYielded` (code, 0x800d2eb0–0x800d2f30)

Reports whether the RSP task has yielded: reads SP_STATUS and, when the yield signal is set, clears it and marks the task as yielded.

Evidence: 0x800d2eb0: single call to os_internal_sp_get_status (0x800d2ec0), 32 instructions.

#### `os_internal_sp_get_status` (code, 0x800d6140–0x800d614c)

Returns SP_STATUS (0xA4040010).

Evidence: 0x800d6140: lui t6,0xa404; jr ra; lw v0,16(t6).

#### `os_internal_sp_set_status` (code, 0x800d6150–0x800d615c)

Writes $a0 to SP_STATUS (0xA4040010): set/clear halt, broke, interrupt and signal bits.

Evidence: 0x800d6150: lui t6,0xa404; jr ra; sw a0,16(t6).

#### `os_internal_sp_set_pc` (code, 0x800d63f0–0x800d6424)

Writes SP_PC (0xA4080000) from $a0 and returns 0 when the RSP is halted (SP_STATUS bit 0); returns -1 otherwise.

Evidence: 0x800d63f0: reads SP_STATUS, tests bit 0 (`andi t7,a1,1`), stores a0 to 0xA4080000 on the halted path.

### RDP

#### `osDpGetStatus` (code, 0x800d3310–0x800d331c)

Returns DPC_STATUS (0xA410000C).

Evidence: 0x800d3310: lui t6,0xa410; jr ra; lw v0,12(t6).

#### `osDpSetStatus` (code, 0x800d3320–0x800d332c)

Writes $a0 to DPC_STATUS (0xA410000C).

Evidence: 0x800d3320: lui t6,0xa410; jr ra; sw a0,12(t6).

### Audio interface

#### `osAiSetNextBuffer` (code, 0x800bc500–0x800bc574)

Queues the next audio DMA buffer (a0 address, a1 length): writes AI_DRAM_ADDR and AI_LEN (0xA4500004) when the AI is not full (AI_STATUS 0xA450000C), compensating with a flag byte at 0x8010f760 when the previous buffer ended on an 0x2000 boundary.

Evidence: 0x800bc500: reads the flag byte at 0x8010f760 (0x800bc504), AI_STATUS and AI_LEN; 29 instructions, no calls.

#### `osAiSetFrequency` (code, 0x800d3120–0x800d3264)

Sets the audio sample rate (a0 Hz): divides the video clock word at 0x80006878 by it to get the AI_DACRATE value, returns -1 below 132, writes AI_DACRATE (0xA4500010) with the value minus one and AI_BITRATE (0xA4500014) with min(value / 66, 16) minus one, and returns the clock divided by the value.

Evidence: 0x800d3120: loads the word at 0x80006878 (0x800d3124-0x800d3128), compares the divisor with 132 (0x800d31ec), divides by 66 (0x800d3204) and caps at 16 (0x800d3210); stores at 0x800d3220 (offset 16 of the 0xA450 base) and 0x800d3228 (offset 20); returns clock / divisor (0x800d3234).

#### `osAiGetLength` (code, 0x800d39a0–0x800d39ac)

Returns AI_LEN (0xA4500004), the bytes left in the audio DMA.

Evidence: 0x800d39a0: lui t6,0xa450; jr ra; lw v0,4(t6).

### Serial interface

#### `os_internal_si_create_access_queue` (code, 0x800d05d0–0x800d0620)

Creates the SI access queue (a one-message queue, primed with one message) and sets the init flag at 0x80103bf0.

Evidence: 0x800d05d0: stores 1 to 0x80103bf0 (0x800d05d8..), calls osCreateMesgQueue then osSendMesg.

#### `os_internal_si_get_access` (code, 0x800d0620–0x800d0664)

Blocks until the SI is free: creates the access queue on first use (flag 0x80103bf0), then receives from it.

Evidence: 0x800d0620: tests 0x80103bf0 (0x800d0620-0x800d0628); calls os_internal_si_create_access_queue when clear, then osRecvMesg(queue, &msg, 1).

#### `os_internal_si_rel_access` (code, 0x800d0664–0x800d0690)

Releases the SI by sending a message to the access queue.

Evidence: 0x800d0664: osSendMesg(queue 0x80129c28, 0, 0).

#### `os_internal_si_raw_start_dma` (code, 0x800d0ed0–0x800d0f7c)

Starts a transfer between RDRAM and the PIF RAM (a0 = 0 write to PIF, 1 read from PIF; a1 = RAM address): writes the data cache back before a write to the PIF and invalidates it after a read; writes SI_DRAM_ADDR (0xA4800000) and SI_PIF_ADDR_RD64B (0xA4800004) or SI_PIF_ADDR_WR64B (0xA4800010); returns -1 while SI_STATUS (0xA4800018) is busy.

Evidence: 0x800d0ed0: calls osWritebackDCache, osVirtualToPhysical and osInvalDCache; touches 0xA4800000/04/10/18.

### EEPROM

#### `osEepromLongRead` — not present

EEPROM access (not present).

Evidence: The only function that starts an SI DMA, the path to the PIF that carries EEPROM commands, is os_internal_si_raw_start_dma (0x800d0ed0). Its eight callers are osContInit, osContStartQuery, osContStartReadData, os_internal_pfs_select_bank, os_internal_pfs_get_status, os_internal_pfs_pak_probe, os_internal_cont_ram_read and os_internal_cont_ram_write. The packets they build use the command bytes 0 (the status request: os_internal_pack_request_data is called with a0 = 0 at 0x800d0770 and 0x800d1688, and the two request builders at 0x800d3d70 and 0x800d50b0 receive 0 from 0x800d3cc4 and 0x800d4f38), 1 (os_internal_pack_read_data), 2 (0x800d4c60) and 3 (0x800d3b70..); none builds an EEPROM packet (commands 4 and 5 on channel 4).

#### `osEepromLongWrite` — not present

EEPROM access (not present).

Evidence: The only function that starts an SI DMA, the path to the PIF that carries EEPROM commands, is os_internal_si_raw_start_dma (0x800d0ed0). Its eight callers are osContInit, osContStartQuery, osContStartReadData, os_internal_pfs_select_bank, os_internal_pfs_get_status, os_internal_pfs_pak_probe, os_internal_cont_ram_read and os_internal_cont_ram_write. The packets they build use the command bytes 0 (the status request: os_internal_pack_request_data is called with a0 = 0 at 0x800d0770 and 0x800d1688, and the two request builders at 0x800d3d70 and 0x800d50b0 receive 0 from 0x800d3cc4 and 0x800d4f38), 1 (os_internal_pack_read_data), 2 (0x800d4c60) and 3 (0x800d3b70..); none builds an EEPROM packet (commands 4 and 5 on channel 4).

#### `osEepromProbe` — not present

EEPROM access (not present).

Evidence: The only function that starts an SI DMA, the path to the PIF that carries EEPROM commands, is os_internal_si_raw_start_dma (0x800d0ed0). Its eight callers are osContInit, osContStartQuery, osContStartReadData, os_internal_pfs_select_bank, os_internal_pfs_get_status, os_internal_pfs_pak_probe, os_internal_cont_ram_read and os_internal_cont_ram_write. The packets they build use the command bytes 0 (the status request: os_internal_pack_request_data is called with a0 = 0 at 0x800d0770 and 0x800d1688, and the two request builders at 0x800d3d70 and 0x800d50b0 receive 0 from 0x800d3cc4 and 0x800d4f38), 1 (os_internal_pack_read_data), 2 (0x800d4c60) and 3 (0x800d3b70..); none builds an EEPROM packet (commands 4 and 5 on channel 4).

#### `osEepromRead` — not present

EEPROM access (not present).

Evidence: The only function that starts an SI DMA, the path to the PIF that carries EEPROM commands, is os_internal_si_raw_start_dma (0x800d0ed0). Its eight callers are osContInit, osContStartQuery, osContStartReadData, os_internal_pfs_select_bank, os_internal_pfs_get_status, os_internal_pfs_pak_probe, os_internal_cont_ram_read and os_internal_cont_ram_write. The packets they build use the command bytes 0 (the status request: os_internal_pack_request_data is called with a0 = 0 at 0x800d0770 and 0x800d1688, and the two request builders at 0x800d3d70 and 0x800d50b0 receive 0 from 0x800d3cc4 and 0x800d4f38), 1 (os_internal_pack_read_data), 2 (0x800d4c60) and 3 (0x800d3b70..); none builds an EEPROM packet (commands 4 and 5 on channel 4).

#### `osEepromWrite` — not present

EEPROM access (not present).

Evidence: The only function that starts an SI DMA, the path to the PIF that carries EEPROM commands, is os_internal_si_raw_start_dma (0x800d0ed0). Its eight callers are osContInit, osContStartQuery, osContStartReadData, os_internal_pfs_select_bank, os_internal_pfs_get_status, os_internal_pfs_pak_probe, os_internal_cont_ram_read and os_internal_cont_ram_write. The packets they build use the command bytes 0 (the status request: os_internal_pack_request_data is called with a0 = 0 at 0x800d0770 and 0x800d1688, and the two request builders at 0x800d3d70 and 0x800d50b0 receive 0 from 0x800d3cc4 and 0x800d4f38), 1 (os_internal_pack_read_data), 2 (0x800d4c60) and 3 (0x800d3b70..); none builds an EEPROM packet (commands 4 and 5 on channel 4).

### FlashRAM

#### `osFlashAllErase` — not present

FlashRAM access (not present).

Evidence: FlashRAM is programmed with command words written to the cartridge through the PI IO write routine (osEPiWriteIo, 0x80005b10, or os_internal_e_pi_raw_write_io, whose only callers are osEPiWriteIo and os_internal_dev_mgr_main). osEPiWriteIo has no caller anywhere in the boot code, the main code file or the overlays' direct calls, so no flash command is ever issued; the save memory is read and written with PI DMA instead (sram_pi_transfer 0x80091a88 calls osEPiStartDma; the callers of sram_transfer 0x80091b14 pass device address 0x08000000).

#### `osFlashClearStatus` — not present

FlashRAM access (not present).

Evidence: FlashRAM is programmed with command words written to the cartridge through the PI IO write routine (osEPiWriteIo, 0x80005b10, or os_internal_e_pi_raw_write_io, whose only callers are osEPiWriteIo and os_internal_dev_mgr_main). osEPiWriteIo has no caller anywhere in the boot code, the main code file or the overlays' direct calls, so no flash command is ever issued; the save memory is read and written with PI DMA instead (sram_pi_transfer 0x80091a88 calls osEPiStartDma; the callers of sram_transfer 0x80091b14 pass device address 0x08000000).

#### `osFlashInit` — not present

FlashRAM access (not present).

Evidence: FlashRAM is programmed with command words written to the cartridge through the PI IO write routine (osEPiWriteIo, 0x80005b10, or os_internal_e_pi_raw_write_io, whose only callers are osEPiWriteIo and os_internal_dev_mgr_main). osEPiWriteIo has no caller anywhere in the boot code, the main code file or the overlays' direct calls, so no flash command is ever issued; the save memory is read and written with PI DMA instead (sram_pi_transfer 0x80091a88 calls osEPiStartDma; the callers of sram_transfer 0x80091b14 pass device address 0x08000000).

#### `osFlashReadArray` — not present

FlashRAM access (not present).

Evidence: FlashRAM is programmed with command words written to the cartridge through the PI IO write routine (osEPiWriteIo, 0x80005b10, or os_internal_e_pi_raw_write_io, whose only callers are osEPiWriteIo and os_internal_dev_mgr_main). osEPiWriteIo has no caller anywhere in the boot code, the main code file or the overlays' direct calls, so no flash command is ever issued; the save memory is read and written with PI DMA instead (sram_pi_transfer 0x80091a88 calls osEPiStartDma; the callers of sram_transfer 0x80091b14 pass device address 0x08000000).

#### `osFlashReadId` — not present

FlashRAM access (not present).

Evidence: FlashRAM is programmed with command words written to the cartridge through the PI IO write routine (osEPiWriteIo, 0x80005b10, or os_internal_e_pi_raw_write_io, whose only callers are osEPiWriteIo and os_internal_dev_mgr_main). osEPiWriteIo has no caller anywhere in the boot code, the main code file or the overlays' direct calls, so no flash command is ever issued; the save memory is read and written with PI DMA instead (sram_pi_transfer 0x80091a88 calls osEPiStartDma; the callers of sram_transfer 0x80091b14 pass device address 0x08000000).

#### `osFlashReadStatus` — not present

FlashRAM access (not present).

Evidence: FlashRAM is programmed with command words written to the cartridge through the PI IO write routine (osEPiWriteIo, 0x80005b10, or os_internal_e_pi_raw_write_io, whose only callers are osEPiWriteIo and os_internal_dev_mgr_main). osEPiWriteIo has no caller anywhere in the boot code, the main code file or the overlays' direct calls, so no flash command is ever issued; the save memory is read and written with PI DMA instead (sram_pi_transfer 0x80091a88 calls osEPiStartDma; the callers of sram_transfer 0x80091b14 pass device address 0x08000000).

#### `osFlashSectorErase` — not present

FlashRAM access (not present).

Evidence: FlashRAM is programmed with command words written to the cartridge through the PI IO write routine (osEPiWriteIo, 0x80005b10, or os_internal_e_pi_raw_write_io, whose only callers are osEPiWriteIo and os_internal_dev_mgr_main). osEPiWriteIo has no caller anywhere in the boot code, the main code file or the overlays' direct calls, so no flash command is ever issued; the save memory is read and written with PI DMA instead (sram_pi_transfer 0x80091a88 calls osEPiStartDma; the callers of sram_transfer 0x80091b14 pass device address 0x08000000).

#### `osFlashWriteArray` — not present

FlashRAM access (not present).

Evidence: FlashRAM is programmed with command words written to the cartridge through the PI IO write routine (osEPiWriteIo, 0x80005b10, or os_internal_e_pi_raw_write_io, whose only callers are osEPiWriteIo and os_internal_dev_mgr_main). osEPiWriteIo has no caller anywhere in the boot code, the main code file or the overlays' direct calls, so no flash command is ever issued; the save memory is read and written with PI DMA instead (sram_pi_transfer 0x80091a88 calls osEPiStartDma; the callers of sram_transfer 0x80091b14 pass device address 0x08000000).

#### `osFlashWriteBuffer` — not present

FlashRAM access (not present).

Evidence: FlashRAM is programmed with command words written to the cartridge through the PI IO write routine (osEPiWriteIo, 0x80005b10, or os_internal_e_pi_raw_write_io, whose only callers are osEPiWriteIo and os_internal_dev_mgr_main). osEPiWriteIo has no caller anywhere in the boot code, the main code file or the overlays' direct calls, so no flash command is ever issued; the save memory is read and written with PI DMA instead (sram_pi_transfer 0x80091a88 calls osEPiStartDma; the callers of sram_transfer 0x80091b14 pass device address 0x08000000).

### Controllers and controller pak

#### `os_internal_pfs_select_bank` (code, 0x800d0200–0x800d0368)

Selects a controller-pak bank: writes the bank number a1 into the 32-byte block used as the bank register through the PIF.

Evidence: 0x800d0200: stores the bank byte into every fourth word position of a 32-byte block (0x800d0280-0x800d0298), 0xFE terminator at 0x80129c80+, SI DMA write then read.

#### `osPfsInit` (code, 0x800d0474–0x800d05d0)

Initialises the controller pak of one channel: osPfsInit(queue, pfs, channel) stores the queue and channel in the pak record, selects banks 0xFE and 0x80 and returns 0 or a non-zero error code.

Evidence: 0x800d0474: stores a0 at +4 and a2 at +8 of the record in a1 and 0xFF at +101 (0x800d0488-0x800d04a4); calls 0x800d38b0 with a1 = 0xFE and 0x80 (0x800d04a8-0x800d04c0) and os_internal_cont_ram_read twice with size 0x400 (0x800d04e4, 0x800d0550); returns 0x0b when the byte read back is not 0xFE / 0x80 (0x800d0518, 0x800d0588) and 0 at the end (0x800d05b8). Its caller 0x800a2a40 runs it for four channels and skips the next bank selection when it returns non-zero.

#### `osContInit` (code, 0x800d0690–0x800d0800)

Initialises the controller interface: waits (with osSetTimer) until 0.5 s after reset have passed, sends a status request for all channels through the PIF and reads back which controllers are connected.

Evidence: 0x800d0690: osGetTime and osSetTimer for the start-up delay (0x800d06a8-0x800d0750), os_internal_si_create_access_queue, os_internal_pack_request_data (0x800d08d0), two os_internal_si_raw_start_dma transfers with osRecvMesg between them and os_internal_cont_get_init_data (0x800d0800) to decode the answer.

#### `os_internal_cont_get_init_data` (code, 0x800d0800–0x800d08d0)

Reads the per-channel status answers from the PIF buffer into OSContStatus entries (type, status, error) and builds the bit pattern of connected channels.

Evidence: 0x800d0800: loops once over the channels (count byte at 0x80129c81), no calls; called by osContInit and osContGetQuery.

#### `os_internal_pack_request_data` (code, 0x800d08d0–0x800d09c4)

Fills the PIF command buffer at 0x80129c40 with one request packet per channel (bytes 0xFF, tx=1, rx=3, command a0, then 0xFF filler) and the 0xFE terminator.

Evidence: 0x800d08d0: zeroes 15 words (0x800d08dc-0x800d0900), sets the control word at 0x80129c7c to 1, builds the 8-byte packet {255,1,3,cmd,255,255,255,255} (0x800d091c-0x800d0958) and copies it once per channel (count byte at 0x80129c81), ending with 254.

#### `osContStartReadData` (code, 0x800d09d0–0x800d0a54)

Starts reading all controllers: gets the SI, sends the read-buttons packet (rebuilding it only when the previous command was not a read) and starts the PIF-to-RAM transfer, completion is signalled on the queue in a0.

Evidence: 0x800d09d0: calls os_internal_si_get_access, os_internal_pack_read_data, os_internal_si_raw_start_dma (write to PIF, osRecvMesg, read from PIF) and os_internal_si_rel_access.

#### `osContGetReadData` (code, 0x800d0a54–0x800d0ae0)

Decodes the PIF answer into an OSContPad array (button halfword, signed stick x and y, error byte) for each connected channel.

Evidence: 0x800d0a54: reads the PIF buffer at 0x80129c40 with the channel count byte at 0x80129c81; no calls.

#### `os_internal_pack_read_data` (code, 0x800d0ae0–0x800d0ba8)

Fills the PIF command buffer with one read-buttons packet per channel (bytes 0xFF, tx=1, rx=4, command 1, then 0xFFFF and -1 -1 as the answer area) and the 0xFE terminator.

Evidence: 0x800d0ae0: builds the packet {255,1,4,1,0xffff,-1,-1} (0x800d0b1c-0x800d0b58) and copies it per channel, ending with 254.

#### `osContStartQuery` (code, 0x800d1660–0x800d16e4)

Starts a status query of all controllers: like osContStartReadData but sends the request-status packet built by os_internal_pack_request_data.

Evidence: 0x800d1660: calls os_internal_si_get_access, os_internal_pack_request_data, os_internal_si_raw_start_dma, os_internal_si_rel_access and osRecvMesg.

#### `osContGetQuery` (code, 0x800d16e4–0x800d170c)

Decodes the status-query answer into OSContStatus entries by calling os_internal_cont_get_init_data.

Evidence: 0x800d16e4: single call to 0x800d0800.

#### `os_internal_cont_ram_write` (code, 0x800d3a50–0x800d3c9c)

Writes a 32-byte block to a controller pak: builds the packet {255, tx=35, rx=1, command 3, address, data..., crc}, runs it through the PIF and checks the CRC byte.

Evidence: 0x800d3a50: PIF packet bytes 255, 35, 1, 3 (0x800d3b68-0x800d3b88) and 255/254 terminators (0x800d3b8c-0x800d3b94); two SI DMA transfers with osRecvMesg between them.

#### `os_internal_pfs_pak_probe` (code, 0x800d3ca0–0x800d3d70)

Controller-pak command exchange that stores the command byte 0xFA at 0x80103c64, packs and sends one packet, reads the answer back and reduces it to a small status code (0, 1, 2 or 4).

Evidence: 0x800d3ca0: stores 250 at 0x80103c64 (0x800d3cb0-0x800d3cbc), packs with 0x800d3d70, SI DMA write, osRecvMesg, SI DMA read, osRecvMesg, unpacks with 0x800d3e34 and returns 2/1/4 from the flag bits 0x1, 0x2, 0x4 of the answer (0x800d3d18-0x800d3d64).

#### `os_internal_cont_ram_read` (code, 0x800d4b70–0x800d4d94)

Reads a 32-byte block from a controller pak: packet {255, tx=3, rx=33, command 2, address}, verifies the CRC of the answer.

Evidence: 0x800d4b70: PIF packet bytes 255, 3, 33, 2 (0x800d4c54-0x800d4c78), terminators 255/254; two SI DMA transfers.

#### `os_internal_pfs_get_status` (code, 0x800d4f10–0x800d50b0)

Probes the controller pak on a channel (up to 3 retries): sends a status packet, reads the answer and decodes the flag bits.

Evidence: 0x800d4f10: retry counter initialised to 3 (0x800d4f18), two SI DMA transfers with osRecvMesg, answer decoded with 0x50b0/0x5180 helpers.

### System initialisation

#### `osInitialize` (boot, 0x800031e0–0x80003488)

System start-up: initialises Status, FPCSR, TLB and caches, records TV type and reset information in low memory, programs the AI rate registers and installs the exception vectors.

Evidence: 0x800031e0: 170 instructions. Calls os_internal_set_sr, os_internal_get_sr, os_internal_set_fpc_csr, os_internal_get_cause, osUnmapTLBAll, osMapTLBRdb, osWritebackDCache, osInvalICache, the SI raw IO routines 0x80003db0/0x80005e60, the PI timing capture 0x80003488, bzero 0x80002ff0 and the 64-bit divide/multiply helpers; touches AI_CONTROL 0xA4500008, AI_DACRATE 0xA4500010, AI_BITRATE 0xA4500014.

### Overlays

#### `overlay_relocate` (code, 0x800cd160–0x800cd428)

Relocates a loaded overlay image: overlay_relocate(a0 = RAM address of the loaded file, a1 = address of the section-size header at the end of the file, a2 = link address of the overlay). Walks the relocation words after the header and rebases R_MIPS_32 words, 26-bit jumps, and HI16/LO16 pairs from the link address to the load address.

Evidence: 0x800cd160: section base table on the stack (section 1 = a0, 2 = a0+text size (+0 of the header), 3 = +data size (+4)); relocation count at header +0x10 (0x800cd1f0), words from header +0x14 (0x800cd204); section = word >> 30 (0x800cd210), type = word & 0x3f000000 (0x800cd228), offset = word & 0xffffff (0x800cd218); type 2: `if (w & 0x0f000000) == 0 then w = w - link + load` (0x800cd264-0x800cd274); type 4: ((w & 0x3ffffff) << 2 | 0x80000000) - link + load, re-encoded (0x800cd2ac-0x800cd2e8); type 5: remembers the lui word per register (0x800cd2f4-0x800cd320); type 6: rebases the combined hi/lo address with carry and rewrites both halves (0x800cd330-0x800cd3b8); other types are skipped (0x800cd254).

#### `overlay_load` (code, 0x800cd428–0x800cd5a8)

Loads and relocates an overlay: overlay_load(a0 = virtual ROM start, a1 = virtual ROM end, a2 = link start address, a3 = link end address, stack arg = RAM destination). Reads the file with rom_file_load, relocates it, clears the BSS that follows it, writes back the data cache and invalidates the instruction cache over the loaded size and returns that size.

Evidence: 0x800cd428: rom_file_load(dest, a0, a1 - a0) (0x800cd4a0); header = end - *(end - 4) (0x800cd4b4-0x800cd4c4); overlay_relocate(dest, header, a2) (0x800cd508); when the BSS size at header +0xc is non-zero clears it right after the loaded bytes with 0x80002ff0 (0x800cd544-0x800cd548); osWritebackDCache and osInvalICache over a3 - a2 bytes (0x800cd55c-0x800cd570); returns a3 - a2.

<!-- os-routines:end -->
