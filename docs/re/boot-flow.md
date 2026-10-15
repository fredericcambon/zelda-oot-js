# Boot flow

From the ROM header to the first game thread, as read from the PAL 1.0 ROM. Addresses are virtual. `out/inventory.json` and `npx tsx tools/analyze/disasm.ts <image> <addr>` (see `rea-howto.md`) reproduce every listing cited here. Routine names and contracts are in `os-routines.md`.

## 1. Entry point and hand-off

- ROM header word at `0x08` is `0x80000400` (`rom-layout.md`): the entry address. The ROM-resident IPL3 stage copies the ROM from offset `0x1000` to RAM at that address before jumping (documented behaviour of the console boot, not code in this ROM); the boot image is `0x80000400`–`0x80006D50`, the rest of the 0x6950 bytes being text, data and rodata of the boot code.
- Nothing in this ROM's code writes the low-memory words that follow, yet the code reads them; the runtime must provide them (they come from the boot hardware stage on a console):

| Address | Read at | Use observed |
| --- | --- | --- |
| `0x80000300` | `0x8000067C`, `0x80000800`, `0x800033DC`, `0x80003400`, `0x800053E0` | TV type. `osInitialize` picks the clock constant stored at `0x80006878` from it: 0 → `0x02F5B2D2`, 2 → `0x02E6025C`, anything else → `0x02E6D354` (`0x800033E8`–`0x80003430`). The first thread switches on 0, 1 and 2 (`0x80000688`–`0x8000069C`). The 0 branch yields 49,656,530, the PAL video clock value listed on n64brew. |
| `0x80000308` | `0x80003C48` (`os_internal_pi_raw_start_dma`) | ORed into every PI cartridge address to form PI_CART_ADDR. |
| `0x8000030C` | `0x800033B4` (`osInitialize`) | when zero, `osInitialize` clears 0x40 bytes at `0x8000031C` (`0x800033C8`–`0x800033D4`). |
| `0x80000318` | `0x8000046C`, code at `0x800A492C` and others | RAM size; **written** by `boot_main` at `0x800004E4`. |

## 2. `boot_entry` (`0x80000400`–`0x80000434`)

1. Zeroes `0x4A20` bytes (two `sw zero` per iteration, 8 bytes per step) starting at `0x80006D50`: the boot BSS, `0x80006D50`–`0x80009770` (`0x80000400`–`0x8000041C`).
2. Loads `t2 = 0x80000498` and jumps with `jr t2`; the delay slot at `0x80000430` finishes `sp = 0x80007740` (`lui sp,0x8000` at `0x80000424`, `addiu sp,sp,0x7740`).

**Register state left for `boot_main`:** `sp = 0x80007740`, `t0 = 0x80009770`, `t1 = 0`, `t2 = 0x80000498`; everything else is what the previous stage left, and `boot_main` does not read it (it saves `ra` and sets every argument it uses). The stack lies inside the zeroed BSS. A runtime that starts at `boot_main` needs only a valid `sp` and the three low-memory words above.

## 3. `boot_main` (`0x80000498`–`0x80000594`), in order

| Step | Call | Observed effect |
| --- | --- | --- |
| 1 | `0x800019F0` (`0x800004CC`) with `a0 = 0x80006D50`, `a1 = 0x80007340`, `a2 = 0x80007740`, `a3 = 0` and stack arguments `-1`, `0x80006A70` | stack-region registration helper |
| 2 | `0x80003FF0` (`0x800004D4`) | RAM size probe: starts at `0x400000`, tests complemented words at the start and at `+0x100000 − 4` of each 1 MiB step (`0x80003FF4`–`0x800040B4`); result saved at `0x80000318` (`0x800004E4`) |
| 3 | `0x800016D0` (`0x800004E0`) | not in the OS list |
| 4 | `0x80000460` (`0x800004E8`) | clears RAM from `0x8000B770` up to the RAM size |
| 5 | `osInitialize` (`0x800004F0`) | see section 4 |
| 6 | `0x80005990`, `0x80001760` (`0x800004F8`, `0x80000504`) | cartridge PI domain set-up; the resulting handle is stored at `0x80006730` (`0x80000508`) |
| 7 | `0x800013E0` (`0x8000050C`) | reads one byte of the cartridge header with `osEPiReadIo` |
| 8 | `0x800019F0` again (`0x80000540`) | second stack region: `0x80007320` |
| 9 | `osCreateThread(0x80006D70, id 1, entry 0x8000063C, arg 0, stack 0x80007320, priority 10)` (`0x80000570`) | first thread |
| 10 | `osStartThread(0x80006D70)` (`0x8000057C`) | nothing is running yet, so it dispatches thread 1; `boot_main` never resumes |

## 4. `osInitialize` (`0x800031E0`)

In order: sets a flag word at `0x80008F90` (`0x800031EC`–`0x800031FC`); sets Status bit `0x20000000` (`0x80003200`–`0x80003208`, CU1); writes FPU control/status `0x01000800` (`0x80003210`–`0x80003218`); performs a PI read/write handshake with the address `0x1FC007FC` (physical, `0x8000321C`–`0x80003284`), writing back the value read with bit 3 set; copies the 16-byte stub `os_internal_exception_vector` (`0x800025A0`) to `0x80000000`, `0x80000080`, `0x80000100` and `0x80000180` (`0x80003290`–`0x80003348`), writes back the data cache and invalidates the instruction cache over `0x190` bytes from `0x80000000` (`0x8000334C`–`0x8000335C`); calls `0x80003488`, which records PI timing registers into a table at `0x80008FA4`–`0x8000901F`; `osUnmapTLBAll` (`0x80003368`) and `osMapTLBRdb` (`0x80003370`); rewrites the 64-bit word at `0x80006870` with the 64-bit helpers `0x80002448` and `0x80002348`; stores the clock constant (section 1); if Cause bit `0x1000` is set it spins forever (`0x80003434`–`0x80003448`); writes AI_CONTROL = 1 (`0xA4500008`), AI_DACRATE = `0x3FFF` (`0xA4500010`) and AI_BITRATE = 15 (`0xA4500014`) (`0x80003450`–`0x80003470`).

## 5. Thread start order

Priority decides who actually runs; the list is the order of `osStartThread` calls from the first thread onwards.

| # | Started at | Thread (id) | Entry | Priority | Created by |
| --- | --- | --- | --- | --- | --- |
| 1 | `0x8000057C` | boot thread (1) | `0x8000063C` | 10 | `boot_main` |
| 2 | `0x80006000` | VI manager (0) | `os_internal_vi_mgr_main` | argument of `osCreateViManager`: 254 (`0x80000648`) | thread 1 |
| 3 | `0x800037A0` | PI manager (0) | `os_internal_dev_mgr_main` | argument of `osCreatePiManager`: 150 (`0x8000073C`) | thread 1 |
| 4 | `0x800007AC` | main boot thread (3) | `0x800005A0` | 10 | thread 1 |
| 5 | `0x8000107C` | DMA manager (18) | `dma_manager_thread` (`0x80000DE8`) | 16 | `dma_manager_init`, called by thread 3 at `0x800005AC` |

Thread 1 finishes by calling `osSetThreadPri(0, 0)` (`0x800007B8`) and spinning at `0x800007C0`, so it becomes the idle thread. Thread 3 calls `rom_file_load(0x800116E0, 0xA89000, 0x1014F0)` (`0x800005DC`), clears the code BSS (`0x80112BD0`, `0x80129E50 − 0x80112BD0` bytes) with `0x80002FF0` and calls `code_entry` (`0x800A2390`) at `0x80000624`, passing its own argument (0).

`code_entry` (`0x800A2390`–`0x800A273C`) then creates and starts the game's threads, in this order (each wrapper calls `osCreateThread` and `osStartThread` back to back; where id or priority is a wrapper parameter it is not constant):

| Call site in `code_entry` | Wrapper | `osCreateThread` / `osStartThread` | Entry | Id | Priority |
| --- | --- | --- | --- | --- | --- |
| `0x800A23CC` | `0x800AFB1C` | `0x800AFC00` / `0x800AFC08` | `0x800AF850` | 2 | 127 |
| `0x800A24DC` | `0x800ADA18` | `0x800ADABC` / `0x800ADAC4` | `0x800AD944` | 19 | parameter |
| `0x800A2544` | `0x800A3E0C` | `0x800A3EB0` / `0x800A3EB8` | `0x800A3CD8` | 5 | parameter |
| `0x800A25D0` | `0x800A0D70` | `0x800A0E24` / `0x800A0E2C` | `0x800A0C14` | parameter | parameter |
| `0x800A2638` | `0x800A3154` | `0x800A3224` / `0x800A322C` | `0x800A3058` | parameter | parameter |
| direct | – | `0x800A26A8` / `0x800A26B4` | `0x800A2074` | 4 | 11 |

After the last start, `code_entry` calls `osSetThreadPri(0, 15)` (`0x800A26BC`–`0x800A26C4`), raising thread 3 from 10 to 15, then loops on a blocking `osRecvMesg` (`0x800A26D4`) on a queue in its own frame; when it receives a null message it calls `osDestroyThread` on thread 4 (record `0x8012BA08`, `0x800A2714`) and returns. What these game threads do is game logic and out of scope here.

## 6. What the runtime must reproduce

- The low-memory words in section 1 before `boot_main` runs, and the boot stack pointer if it starts there.
- Thread creation does not run anything; `osStartThread` from a context with no running thread dispatches immediately. The order above is observable only through priorities: 254 (VI manager) > 150 (PI manager) > 127 (id 2) > 16 (DMA manager) > 16 > 15 (thread 3 after `code_entry`) > 11 > 10 (thread 1 until it lowers itself) > 0 (thread 1 afterwards).
- Thread 1 creates the VI and PI managers before thread 3 exists; thread 3 creates the DMA manager before its first file read, and that read goes through the DMA manager and the PI manager.
