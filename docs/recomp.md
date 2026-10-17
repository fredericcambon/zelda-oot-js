# Recompiler core (integer ISA)

`tools/recomp/emit.ts` turns MIPS III (VR4300) code into C over the `Cpu` context of `runtime/cpu.h`.
Each function becomes `void fn_<addr>(Cpu *c)`.

## Translation rules

- GPRs are `uint64_t`. 32-bit operations read the low word and write it sign-extended. `$zero` is never written.
- Branches fold the delay slot in: the condition is evaluated first, then the slot, then the transfer. Likely branches run the slot only when taken. Branch-and-link writes `$ra` unconditionally, before the slot.
- Branch targets inside the function become `goto` labels. A target that is a delay slot gets a standalone copy of the slot.
- A transfer outside the function is a tail call. `jal` is a direct call, `jalr` and `jr` (other than `$ra`) go through `rt_call`. `jr $ra` returns.
- Exceptions (`add`-family overflow, `tge`-family, `break`, `syscall`) call `rt_trap`, which does not return. A word that is not an instruction of the VR4300 calls `rt_unimpl`; generation refuses to emit one. The recorded pc of an exception in a delay slot is the slot's address.
- MOVZ and MOVN are not part of MIPS III and are not translated.

## Choices the manuals leave open

- `div`/`divu`/`ddiv`/`ddivu` by zero is unpredictable in the manual; the runtime fixes `LO = -1` (or `1` for a negative signed dividend) and `HI = dividend`.
- `lwr` that does not load a whole word keeps the upper 32 bits of the register; `lwl` and a whole-word `lwr` sign-extend.

## Tests

`tools/recomp/*.test.ts` assemble snippets (`asm.ts`), recompile them, build all snippets of a file with one Emscripten call, run them in Node and compare every register, HI/LO and the first 64 KiB of RDRAM with the hand-computed expectation (anything not listed must be unchanged). They use Emscripten from `$EMSDK` or `.tools/emsdk`; a vitest global setup fetches it when missing and the tests fail if that is impossible.

## Floating point (COP1)

Registers are stored as raw bits in `Cpu.f[]`; `Cpu.fr` selects the register model. With `fr == 1` every register is a full 64-bit register. With `fr == 0` an odd register is the upper half of the even register before it and doubles use the even register. `mtc1`/`lwc1` write only the addressed 32-bit half; `mfc1` sign-extends.

- Single and double `add sub mul div sqrt abs neg mov`, `cvt.{s,d,w,l}`, `round/trunc/ceil/floor.{w,l}` and all sixteen compares are translated. `abs`, `neg` and `mov` work on the raw bits, so NaN payloads are untouched.
- `cvt.w/l` round with the mode in FCSR bits 1:0 (nearest even, toward zero, up, down); `round/trunc/ceil/floor` fix their own mode. A NaN or out-of-range operand, which the VR4300 reports as an unimplemented-operation exception, saturates to the largest (or, for large negative values, the smallest) destination value.
- Arithmetic always rounds to nearest even (WebAssembly has no other mode) and generates no FCSR flag or cause bits. Only the condition bit (23) is maintained. `ctc1 $31` keeps bits `0x0183ffff`. `cfc1 $0` returns `Cpu.fir`, which the runtime sets.
- `bc1t/bc1f` and their likely forms test the condition bit before the delay slot runs.
- Generated code must be compiled with `-ffp-contract=off` so that no fused multiply-add changes a result.

## COP0, TLB, cache

`mfc0/dmfc0/mtc0/dmtc0` call `rt_mfc0`/`rt_mtc0`, `tlbr/tlbwi/tlbwr/tlbp` call `rt_tlb`, `cache` calls `rt_cache` and `eret` calls `rt_eret`, which never returns into the function. The runtime defines all of them (`runtime/stub.c` has inert versions).

## Jump tables

A `jr` that the inventory lists as a table dispatch becomes `switch (target)` over the table's distinct targets that lie in the function, each a `goto`. Values outside the table, including targets in other functions, go through `rt_call`, so that the jump has one call site (see "Calls and the shadow stack"). The switch is on the target address, so no index expression has to be recovered.

## Overlays

An overlay is translated against its link address. The game's own loader relocates the loaded copy, so the translation must reach the loaded data and code:

- The `lui` of a relocated hi/lo pair keeps the link-time value. The instruction that carries the low half (`addiu`, `ori`, loads, stores, `lwc1`, ...) adds `delta = load address - link address`, which is `ovl_NNNN_delta` (`oot_images[k].delta`). Since `(hi << 16) + lo + delta` is what the loader computes for the pair, the result is the same.
- Jump-table dispatches subtract `delta` from the register before the `switch`, because the tables in the loaded rodata hold relocated addresses.
- `jal` and tail calls inside the overlay call the recompiled functions directly. Indirect calls use the dispatch tables, which are keyed by link address: `oot_lookup(addr)` finds the image whose `[link_start + delta, link_end + delta)` contains `addr` (loaded images only) and looks up `addr - delta`.

## Calls and the shadow stack

Every call to a function that can suspend the thread (one that calls through the dispatch tables, or reaches a blocking OS routine:
`SUSPENDING_ROUTINES` in `tools/recomp/generate.ts`) is emitted as `OOT_PUSH(key); callee(c); D_key:; OOT_POP();`, with the key of its
`CallSite` (`emit.ts`). This covers `jal`, linking branches, `jalr`, a `jr` that leaves the function, tail calls and the fall into the next
function. A function with call sites begins with `if (OOT_RESUMING()) goto resume_entry` and ends with a `switch` over its keys to the
code that re-issues each call (`Q_key`), which jumps back to `D_key`. `recompileFunction` throws if a C local is declared outside a call and
read after it (`liveLocalsAfterCalls`). Calls to functions that cannot suspend (`EmitOptions.frameless`) are plain calls. The rules and the runtime
side are in `docs/runtime.md`, "Portable save states".

## Generated files

`npm run recomp` (`tools/recomp/generate.ts`) writes `generated/c/`:

- one `<image>.c` per image (`boot`, `code`, `ovl_NNNN`) with its functions and `oot_dispatch_<k>`, a table sorted by guest address;
- `images.c`, the registry `oot_images[]` (`runtime/dispatch.h`);
- `oot_gen.h`, declarations and the overlay delta macros;
- `os_bindings.c`: a weak `rt_<routine>` for every OS routine the inventory identified (`docs/re/os-routines.md`) that calls the recompiled original. Every call and dispatch entry for such a routine goes to `rt_<routine>`, so a runtime that defines the symbol replaces the routine;
- `sites.c`: `oot_sites`, the call sites that keep a frame on the shadow stack, by key (function, entry address, call address);
- `missing.c`: `rt_missing` stubs for direct transfers whose target lies in no image (`jal 0x801c5c6c` and similar in the PAL code, an address beyond the code file's BSS). A direct transfer into the middle of another routine gets a function of its own that runs from the target to the end of that routine.

Generation fails when an instruction cannot be translated (`rt_unimpl` would be emitted) or a function cannot be recompiled.

## The port command

`npm run port -- --rom <path>` runs: verify and extract the ROM (`out/`), analyse (`out/inventory.json`, Ghidra unless `--no-ghidra`), recompile (`generated/c`), compile every C file with Emscripten in parallel (`generated/obj`, `-O1` or `--optimize`), and link with `runtime/stub.c` into `dist/oot.js` and `dist/oot.wasm`. Unchanged inputs are not rebuilt. The stub runtime links and exits; it provides no OS services yet. Emscripten is fetched into `.tools/emsdk` when missing, and the snippet tests do the same instead of skipping.
