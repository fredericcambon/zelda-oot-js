# Analysis tools: Ghidra, REA and our own discovery

## Decision

The analysis is Ghidra headless plus our own discovery code. REA (`rea-agents`) was **not installed and not run**: no comparison between REA and Ghidra was measured, so none is claimed here. The choice rests on three observable properties of the pipeline:

- it must run unattended from `npm run analyze`, on a ROM the user supplies, with no agent session;
- Ghidra is fetched at a pinned version with a SHA-256 check (`tools/analyze/setup.mjs`: Ghidra 12.1.4 and Temurin JDK 21.0.12.1 into git-ignored `.tools/`), and the scripts that drive it live in this repo (`tools/analyze/ghidra/`);
- nothing the pipeline needs depends on a model: OS routines are recognised by rules (`data/os-signatures.json`), not by asking anything.

REA would be an addition, not a replacement, if later needed. If installed it must be pinned and its `setup` command must never run (it writes agent configuration).

## What each part contributes

| Stage | Code | Role |
| --- | --- | --- |
| Layout | `tools/analyze/layout.ts` | Finds the boot code, the main code file and the 469 overlay descriptors from ROM bytes alone. |
| ELF images | `tools/elf-wrap/` | Wraps each image (boot, code, every overlay) as an ELF with its relocation sections so Ghidra can load it. |
| Ghidra | `tools/analyze/ghidra/SeedFunctions.java`, `ExportFacts.java`, `tools/analyze/ghidra.ts` | Runs the auto-analysis after seeding entry points our own evidence supports; exports function ranges, resolved indirect jumps and calls, and the ranges it turned into data. |
| Own discovery | `tools/analyze/discover.ts`, `image.ts`, `constprop.ts` | Instruction-level descent from entries, `jal` targets, pointers and relocations; jump-table recovery; gap and fragment handling; merges Ghidra's facts when present. |
| OS identification | `tools/analyze/os.ts`, `features.ts` | Applies the rules of `data/os-signatures.json` to the boot and code images. |
| Coverage | `tools/analyze/coverage.ts` | Classifies every byte as function, padding or data and reports sections below 99% (`coverage.md`). |

## What was used for the OS routines

The OS-routine results in `os-routines.md` come from **our own discovery only** (`--no-ghidra`). That run finds 144 functions in the boot image, 2963 in the code image and 13,153 over all 471 images, the same counts that `coverage.md` records for the earlier Ghidra-assisted run, and all 123 rules resolve to one address while the 17 absence predicates hold. Ghidra was not re-run for this task, so identical counts are what was observed, not a proof that Ghidra's boundaries equal ours function by function.

Examples of what that run resolves: `boot_entry` `0x80000400`, `osCreateThread` `0x80003090`, `osSendMesg` `0x80001F80`, `os_internal_exception` `0x800025B0`, `overlay_relocate` `0x800CD160`.

Everything below that level was done by reading disassembly produced by `tools/analyze/disasm.ts` (our own MIPS decoder, `tools/analyze/mips.ts`) and by scans over the image bytes (callers of an address by `jal` opcode, constant-address `lui` patterns, low-memory accesses). No Ghidra decompiler output was used; the Ghidra output used elsewhere is only function ranges and indirect-jump targets.

## Limits

- Rules identify routines by shape and by what they call, so a routine that is rebuilt differently in another ROM revision needs its rule re-checked; this document and the test cover only PAL 1.0.
- Function boundaries inside the boot and code images come from heuristics plus Ghidra; the inventory test (`tools/analyze/inventory.test.ts`) checks that ranges never overlap and that coverage stays above 99% per section, not that every boundary is right.
- Names are our labels. Each carries evidence addresses in `data/os-signatures.json`; a name is never evidence by itself.
