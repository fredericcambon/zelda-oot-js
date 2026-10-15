# Overlays: descriptor tables and relocation format

Findings from the PAL 1.0 ROM. Code: `tools/analyze/layout.ts` (`findOverlays`, `parseFooter`) and `tools/analyze/relocs.ts`. Routine addresses are in `os-routines.md`. Figures below are produced by `npx tsx tools/analyze/cli.ts` (see `rea-howto.md`) and are checked in `tools/analyze/inventory.test.ts` (at least 469 overlays).

## Summary

- 469 overlay files, file-table indices 30–498 (not every index in that range is an overlay), each linked at its own address between `0x80800000` and `0x80B88050`. No two link ranges overlap and every link start is 16-aligned.
- An overlay is a file of the file table (see `rom-layout.md`) holding text, data and rodata, then a relocation list and a footer. BSS is not stored.
- The game loads an overlay with `overlay_load` (`0x800CD428`), which calls `rom_file_load` and then `overlay_relocate` (`0x800CD160`). Both are in the main code file.
- The runtime must keep the recompiled code of an overlay linked at its link address and add the load-time delta; see "What the runtime needs".

## Descriptor tables

Each overlay has a descriptor in the data of the main code file (file 28, loaded at `0x800116E0`). A descriptor starts with four words:

| Offset | Meaning | Evidence |
| --- | --- | --- |
| `+0x00` | virtual ROM start of the overlay file | equals a file-table `virtual start` for every one of the 469 records |
| `+0x04` | virtual ROM end | equals that file's `virtual end` |
| `+0x08` | link address (start) | the file's last word and header sizes agree with `+0x0c - +0x08` (below) |
| `+0x0c` | link address (end) | `+0x0c - +0x08` is the file size, header and relocations included (e.g. file 395: `0x80B30900 - 0x80B303A0 = 0x560` = file size) |
| `+0x10` | address the overlay is loaded at; 0 in the ROM | the loader at `0x8001BB30` stores the allocation result here: `sw v0,16(v1)` |
| `+0x14` | link address of a record inside the overlay's data | in file 395 it is `0x80B30890`, the first byte of that overlay's data section (text start `0x80B303A0` + text size `0x4F0`); the code at `0x8001BB64`–`0x8001BB74` converts it to a loaded address as `loaded + (ptr − link start)` |
| later words | per-table fields | not interpreted here |

The records are found by scanning the code file for a word equal to a file's virtual start followed by that file's virtual end and a plausible link range, and are accepted only when the file's footer validates (below). They lie in runs in the code file's data at file offsets `0xD44B0`–`0xD8860` (RAM `0x800E5B90`–`0x800E9F60`), `0xDDBE4`, `0xDE46C` and `0xEAD04`. Record strides seen are `0x1C`, `0x20`, `0x30` and `0x40`; the first run is indexed as `0x800E5B90 + 0x1C * index` by the routine at `0x8001BAD0`–`0x8001BB10` (`sll t8,3; subu; sll 2`), which then reads `+0x08`/`+0x0C`, allocates with `0x80067268`, and calls `overlay_load(+0x00, +0x04, +0x08, +0x0C, allocation)` (`0x8001BB34`–`0x8001BB48`). A second wrapper at `0x800CD5A8` does the same with the allocator `0x800CE2D8` called with `+0x0C − +0x08` bytes (`0x800CD5C0`). Neither the number of tables nor what each describes is claimed here.

## File layout and footer

```
file offset 0                text      textSize bytes (code)
            textSize         data      dataSize bytes
            +dataSize        rodata    rodataSize bytes
            h = text+data+ro header    5 big-endian words: textSize, dataSize, rodataSize, bssSize, relocCount
            h + 0x14         relocations   relocCount words
            ...              zero padding (less than 16 bytes)
            fileSize - 4     back offset   fileSize - h, so the header sits at fileSize - back
```

Evidence: `parseFooter` requires `back` to be a multiple of 4, `textSize + dataSize + rodataSize == h` and the relocation list to end within 16 bytes of the last word; all 469 files satisfy it. Example, file 30: size `0x9C0`, last word `0x80` → header at `0x940`; sizes `0x910, 0x20, 0x10, 0`, 23 relocations (first word `0x45000174`). `overlay_load` finds the header the same way (`header = end − *(end − 4)`, `0x800CD4B4`–`0x800CD4C4`).

Link-time sections follow each other from the link start: text, data, rodata; BSS starts at the 16-aligned end (`overlaySections` in `relocs.ts`). BSS size is header word 3; `overlay_load` clears it right after the loaded bytes with `0x80002FF0` (`0x800CD544`–`0x800CD548`), then calls `osWritebackDCache` and `osInvalICache` over the loaded size (`0x800CD55C`–`0x800CD570`) and returns it.

## Relocation words

Each word of the list is `ssTTTTTT oooooooooooooooooooooooo`:

| Bits | Field | Observed values |
| --- | --- | --- |
| 31–30 | section | 1 text, 2 data, 3 rodata (4 would be BSS; never used) |
| 29–24 | type | 2, 4, 5, 6 |
| 23–0 | offset | byte offset inside that section |

`overlay_relocate(a0 = load address, a1 = header address, a2 = link start)` (`0x800CD160`) builds a base table (section 1 = a0, 2 = a0 + text size, 3 = + data size; `0x800CD1F0`–`0x800CD210`), reads the count at header `+0x10` and the words from header `+0x14`, and per word (`0x800CD210`–`0x800CD3B8`):

| Type | Name (standard MIPS ELF) | Action observed |
| --- | --- | --- |
| 2 | R_MIPS_32 | when `(w & 0x0F000000) == 0`: `w = w − link + load` (`0x800CD264`–`0x800CD274`) |
| 4 | R_MIPS_26 | `((w & 0x3FFFFFF) << 2 | 0x80000000) − link + load`, re-encoded as a jump target (`0x800CD2AC`–`0x800CD2E8`) |
| 5 | R_MIPS_HI16 | remembers the `lui` word per register (`0x800CD2F4`–`0x800CD320`); nothing is rewritten yet |
| 6 | R_MIPS_LO16 | rebases the combined hi/lo address with carry and rewrites both halves (`0x800CD330`–`0x800CD3B8`) |
| other | – | skipped (`0x800CD254`) |

Across the 469 files there are 52,627 relocations: text type 5 × 16,959, text type 6 × 17,005, text type 4 × 11,147, data type 2 × 3,862, rodata type 2 × 3,654. No other combination occurs, so every relocation is a hi/lo pair, a jump target or a 32-bit pointer in data. `tools/analyze/relocs.ts` maps the same numbers onto the standard ELF MIPS relocation types (`R_MIPS_32`, `R_MIPS_26`, `R_MIPS_HI16`, `R_MIPS_LO16`).

## What the runtime needs

- Overlay code is recompiled once against its link address. At run time the loader computes `delta = load − link`; every relocated word in data and every hi/lo pair is `link + delta`.
- A call or `jalr` target inside an overlay arrives as a loaded address. It maps to the recompiled function by `target − delta`. The delta is the one stored with the descriptor (`+0x10 − +0x08`).
- Pointers from the code file into an overlay go through the descriptor (`+0x14`) with the same delta; they are not relocation-list entries.
