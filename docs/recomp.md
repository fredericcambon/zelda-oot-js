# Recompiler core (integer ISA)

`tools/recomp/emit.ts` turns MIPS III (VR4300) integer code into C over the `Cpu` context of `runtime/cpu.h`.
Each function becomes `void fn_<addr>(Cpu *c)`.

## Translation rules

- GPRs are `uint64_t`. 32-bit operations read the low word and write it sign-extended. `$zero` is never written.
- Branches fold the delay slot in: the condition is evaluated first, then the slot, then the transfer. Likely branches run the slot only when taken. Branch-and-link writes `$ra` unconditionally, before the slot.
- Branch targets inside the function become `goto` labels. A target that is a delay slot gets a standalone copy of the slot.
- A transfer outside the function is a tail call. `jal` is a direct call, `jalr` and `jr` (other than `$ra`) go through `rt_call`. `jr $ra` returns.
- Exceptions (`add`-family overflow, `tge`-family, `break`, `syscall`) call `rt_trap`, which does not return. Anything else (FPU, COP0) calls `rt_unimpl`. The recorded pc of an exception in a delay slot is the slot's address.
- MOVZ and MOVN are not part of MIPS III and are not translated.

## Choices the manuals leave open

- `div`/`divu`/`ddiv`/`ddivu` by zero is unpredictable in the manual; the runtime fixes `LO = -1` (or `1` for a negative signed dividend) and `HI = dividend`.
- `lwr` that does not load a whole word keeps the upper 32 bits of the register; `lwl` and a whole-word `lwr` sign-extend.

## Tests

`tools/recomp/*.test.ts` assemble snippets (`asm.ts`), recompile them, build all snippets of a file with one Emscripten call, run them in Node and compare every register, HI/LO and the first 64 KiB of RDRAM with the hand-computed expectation (anything not listed must be unchanged). They look for Emscripten in `$EMSDK` or `.tools/emsdk` (fetched by `npm run build`) and are skipped, with a warning, when it is missing.
