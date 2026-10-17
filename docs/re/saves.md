# Save memory: layout, record, checksum, and the sample file

Evidence from the PAL 1.0 ROM (SHA-1 `328A1F1BEBA30CE5E178F031662019EB32C5F3B5`). Addresses are virtual; `npx tsx tools/analyze/disasm.ts code <start> <end>` lists them. Names are our labels for addresses, not claims about the original. A statement marked *observed* comes from running the built game on a save image (`tools/saves/game.test.ts`), not from reading code alone.

`npm run save -- dump sram <sram.bin>` and `npm run save -- verify <sram.bin>` implement this document (`tools/saves/sram.ts`).

## Routines

All of them are in the main code file. Every transfer goes through `sram_transfer` (`0x80091b14`, `os-routines.md`): `(cartridge address, RAM address, size, 0 read / 1 write)`, cartridge addresses `0x08000000 + offset`.

| Address | Label | What it does (evidence) |
| --- | --- | --- |
| `0x80091964` | `sram_alloc_buffer` | Takes a game-state context `a0` and a result pointer `a1`; calls the allocator `0x800A0908(a0 + 0x74, 0x8000)` and stores the result at `*a1` (`0x80091974`-`0x80091984`). `*a1` is the RAM copy of the save memory used by every routine below. Callers: `0x808008C8` (file 30), `0x80812188` (file select). |
| `0x8009186C` | `sram_header_check` | Reads `0x8000` bytes into the buffer (`0x80091888`-`0x80091898`), compares buffer bytes 3-11 with the 12-byte template at `0x800F9E6C` (nine `lbu 3(...)` pairs, loop `sltiu s0,9` at `0x800918E8`); on a mismatch copies the template over the buffer start (12 bytes, `0x800918CC`) and writes the header with `sram_header_write`. Then loads the settings: byte 0 `& 3` to context `+0x140A`, byte 1 `& 1` to `+0x140C`, byte 2 to `+0x1409` (zeroed and rewritten when it is 3 or more, `0x80091920`-`0x80091940`), and calls `0x800C7C20` with the sound byte. Caller: `0x80800790` (file 30). |
| `0x80091838` | `sram_header_write` | `sram_transfer(0x08000000, *a0, 16, write)`: the first 16 bytes. Callers: `0x800918D4`, `0x8009193C`, `0x8080907C`, `0x8080AFDC` (file select, when a setting changes). |
| `0x80090D0C` | `sram_verify_all` | The boot check of the three files (below). Reads `0x8000` bytes, loops over slots 0-2. Caller `0x8080C0E8` (file select). |
| `0x80090BC0` | `sram_save_slot` | Computes the checksum of the context, writes the context to the primary and the backup copy of the context's slot. Callers `0x80827F90`, `0x80828D80` (file 34). |
| `0x80091238` | `sram_create_file` | Creates a new file in the selected slot from the file select (below). Caller `0x808086B0`. |
| `0x80091504` | `sram_rewrite_slot` | Runs `save_defaults_new_file`, loads the slot at file select `+0x1CA46` into the context and writes the `0x1450`-byte context to the primary and the backup copy (`0x80091578`, `0x80091600`). Caller `0x80806304`. |
| `0x8009161C` | `sram_copy_file` | Loads source slot (file select `+0x1CA46`) into the context, stores its 4948 bytes into the primary and the backup of the destination slot (`+0x1CA5E`), writes the buffer back (`0x8000` bytes), refreshes the file select's copies. Caller `0x808048D8`. |
| `0x8009087C` | `sram_load_slot` | Loads the record of the context's slot from the buffer and adjusts it (below). Caller `0x808115C4` (file select, when a file is chosen). |
| `0x80090590` | `save_defaults_new_file` | Fills the context with the defaults of a new file. Callers `0x80090EB4`, `0x80091258`, `0x80091518`. |
| `0x800906BC` | `save_defaults_no_file` | Another set of defaults, with entrance `0xCD` (`0x80090858`); used when play starts without a file. Callers `0x80800A08` (file 31), `0x80803740` (file 32). |
| `0x80AEDD10` | `sram_erase_all` | In file 362: zeroes a 2048-byte buffer and writes it to the sixteen `0x800`-byte blocks of `0x08000000`-`0x08007FFF` (`0x80AEDD3C`-`0x80AEDEA4`), then zeroes the sound and targeting settings. Empty save memory is all zeros. |

The save context lives at `0x801183D0` (`lui 0x8012; addiu -31792`, used by every routine above; `tools/headless/state.ts` calls it ENTRANCE_INDEX). Offsets below are from that address.

## Layout of the save memory

The game reads and writes `0x8000` bytes (`0x80090D58`, `0x800913A4`...). The runtime keeps 128 KB; only the first `0x8000` matter.

| Offset | Size | Content |
| --- | --- | --- |
| `0x0000` | 16 | Header: byte 0 sound setting, byte 1 targeting setting, byte 2 language (0-2), bytes 3-11 signature `98 09 10 21 5A 45 4C 44 41` (`"ZELDA"` at 7-11), bytes 12-15 untouched. Template at `0x800F9E6C`: `00 00 00 | 98 09 10 21 5A 45 4C 44 41`. |
| `0x0020`, `0x1470`, `0x28C0` | `0x1450` each | Primary copy of file 0, 1, 2. |
| `0x3D10`, `0x5160`, `0x65B0` | `0x1450` each | Backup copy of file 0, 1, 2. |

The offsets are the six halfwords at `0x800F9E60`: `0x20, 0x1470, 0x28C0, 0x3D10, 0x5160, 0x65B0` (read with `lhu 0x800F9E60 + 2*slot`, backup `+6`: `0x80090D8C`, `0x80090DEC`). Records are `0x1450` bytes apart (`addiu a2,5200` at `0x80090C74`), the last ends at `0x6A00`.

Header evidence: the signature loop and the settings are in `sram_header_check` above. Byte 2 is stored by the file select's language screen through `sram_header_write`. A new file's save memory was observed with language 0, `sound` 0, `targeting` 0 and the signature; an interactive save has language 2.

## The record and its checksum

The context's first `0x1354` bytes (4948, `addiu a2,4948` at `0x80090D98`) are what the game loads (`memcpy` from the buffer into `0x801183D0`). It saves `0x1450` (5200) bytes (`0x80090C74`), so bytes `0x1354`-`0x144F` of a saved copy are whatever the context held (not read back; a new file's copy holds zeros there because `sram_create_file` copies 4948 bytes into a zeroed buffer, while a copy written by `sram_save_slot` carries live context bytes there).

**Checksum**: a halfword at record `+0x1352`, big-endian. Its value is the 16-bit sum, modulo `0x10000`, of the 2474 big-endian halfwords `0x0000`-`0x1352` of the record with the checksum halfword itself counted as zero. Evidence: the loops at `0x80090BE0`-`0x80090C1C` (`sh zero,4946(a1)` first, `sltiu at,t0,2474`, `lhu`, `addu`, `andi 0xffff`), at `0x80090DB8`-`0x80090DDC` (the check: the stored halfword is read first, `lhu 4946`, then zeroed, `sh zero,4946`, then summed and compared with `beq` at `0x80090DE0`) and at `0x80091310`-`0x80091340` (new file). A second counter in these loops (`v0`/`s0` wrapping at 32) has no effect on the sum. It reproduces the checksum of the three copies of a save the game wrote (`tools/saves/sram.test.ts`, `game.test.ts`). An all-zero record sums to zero and so passes.

**A file is present** when the file select finds the bytes `5A 45 4C 44 41 5A` (`"ZELDAZ"`) at record `+0x1C`. The file select tests them one by one and takes the file as present when any single byte matches (`0x8080C6A0`-`0x8080C6F8`, `beql` to the present path at each `lbu 28..33(v0)`); the buffer address is `*(fileSelect + 0x1E0)` plus the slot's primary offset (`0x8080C694`-`0x8080C69C`). `sram_create_file` writes the six bytes (`0x800912C8`-`0x800912F0`).

### What the game does at boot (`sram_verify_all`, `0x80090D0C`)

For each slot: copy the primary record into the context, compare the checksum (`0x80090D9C`-`0x80090DE0`).

1. Primary passes: nothing is written, the backup is not read (`beq` to `0x80090F2C`).
2. Primary fails, backup passes (`0x80090DEC`-`0x80090E40`): the context (loaded from the backup, checksum halfword zeroed by the check at `0x80090E08`) is written back to the primary (`0x80090F14`-`0x80090F24`); the primary then keeps a checksum of zero and fails again at the next boot, which restores it again.
3. Both fail (`0x80090E44`-`0x80090F2C`): the first six words of the context are zeroed, `save_defaults_new_file` runs, the checksum is recomputed, and the context is written to both copies: the slot becomes an empty file (no `"ZELDAZ"`).

*Observed*, one game run per case on a game-written image (`tools/saves/game.test.ts`): the image as written is not rewritten during boot to the file list; a corrupted primary makes the game write the save memory and leaves slot 0 present with a failing primary and a passing backup (case 2); two corrupted copies leave slot 0 empty with both copies passing (case 3); a wrong signature byte is rewritten to the template.

`verify` reports which case each slot would take and is `accepted` only when the signature, the language and every primary pass (the game would write nothing). A backup that differs from a passing primary is reported but does not fail it.

### New file (`sram_create_file`, `0x80091238`)

`save_defaults_new_file` (`0x80090590`), then `+0x00 = 0xBB`, `+0x04 = 1`, `+0x08 = 0xFFF1`, `+0x0C = 0x6AAB` (`0x8009126C`-`0x8009128C`), the name from the file select (`+0x1C9FC + 8 * slot`, selected slot at `+0x1CA38`: `0x80091298`-`0x800912C4`), `"ZELDAZ"`, `+0x2C` from the byte at file select `+0x1C9F4` (`0x800912F4`-`0x8009130C`), the checksum, then the 4948 bytes are copied to the primary and the backup in the buffer and the whole `0x8000` buffer is written (`0x80091398`-`0x800913A8`). The record then holds, among the zeros: the template below and these constants set by `save_defaults_new_file` (`0x80090674`-`0x800906A8`): `+0x1348 = 0x0051`, `+0x134A = 0xF8D0`, `+0x134C = 0x0048`, `+0x134E = 0x1579`, `+0x1350 = 0x9527`, `+0x32` byte 0, `+0xF32` halfword 1, `+0x164` word `0x40000000`.

## Record fields

Offsets from the start of a record (= from `0x801183D0`). "Evidence" lists addresses; fields marked *position only* have a place and a default but no established meaning yet, and are left alone by any conversion.

| Offset | Size | Field | Evidence |
| --- | --- | --- | --- |
| `+0x00` | u32 | entrance index | The play state's init reads it (`0x8009B17C`, `headless/state.ts`). `sram_load_slot` overwrites it from the scene and `+0x04` (below), so the value in the file does not decide where play resumes. New file `0xBB`. |
| `+0x04` | u32 | flag (0 / non-zero) | `0x8009098C`-`0x800909C0`: non-zero selects entrance `0xBB`, zero `0x5F4` for scenes without a special case; the play state's init uses it too (`state.ts`). New file 1. |
| `+0x08` | u32 | cutscene index | `state.ts` (play state's init); new file `0xFFF1`. |
| `+0x0C` | u16 | time of day | `state.ts`; new file `0x6AAB`. |
| `+0x1C` | 6 bytes | marker `"ZELDAZ"` | Above. |
| `+0x22` | u16 | number shown by the file select as three decimal digits | Copied to file select `+0x1C9F6 + 2*slot` (`0x800913C8`-`0x800913E0`), read at `0x8080EA0C` and split into hundreds, tens, units by `0x8080C4A4`. |
| `+0x24` | 8 bytes | file name, one character code per byte | Written from the typed name (`0x80091298`-`0x800912C4`), copied to file select `+0x1C9FC + 8*slot`, drawn from `0x8080E8FC`. Blank is `0x3E` (template at `0x800F9E80`-`0x800F9E87`). The character table is not decoded here. |
| `+0x2C` | u16 | position only | Copied from file select `+0x1C9F4` at creation (`0x800912F4`-`0x8009130C`); compared with that byte at `0x8080C7E8`-`0x8080C7F8`. New file 0. |
| `+0x2E` | u16 | heart capacity, 16 units per heart | File select draws `(value + 15) >> 4` hearts (`0x8080EBA4`-`0x8080EBBC`). New file `0x30` (template `0x800F9E8C`). |
| `+0x30` | u16 | current health | File select reads it as the partial-heart value (`0x8080EBA8`-`0x8080EC30`: whole hearts for 16 units, else the remainder); `sram_load_slot` raises it to `0x30` when lower (`0x800909C8`-`0x800909E0`). New file `0x30`. The pairing of capacity and health follows from these two uses. |
| `+0x66` | u16 | scene index | `sram_load_slot` switches on it (`0x800908C0`-`0x80090988`); new file `0x34` (52, the scene of Link's house, `newgame.md`). |
| `+0x68` | 10 bytes | position only | Template at `0x800F9EC4`: `FF` x7, `00 11 00`. `0x80090AA4`-`0x80090AC0` scan `+0x69`-`+0x6B` for the value `0x23` and replace it by `0x22`. |
| `+0x74` | 24 bytes | table of 24 one-byte entries, `0xFF` empty | Template at `0x800F9ED0` (24 x `FF`). `0x80090A98` stores the value `0x22` at `+0x74 + table[0x23]` (table at `0x800F6E94`). The slot meaning of each index is not decoded. |
| `+0x8C` | 16 bytes | table of 16 one-byte counts, default 0 | Template at `0x800F9ED0 + 24`. Not decoded. |
| `+0x9C` | u16 | bit field, default `0x1100` | `sram_load_slot` ORs a bit from a table (`0x800F6B54` shifted by `0x800F6C20`, `0x80090AF4`-`0x80090B18`) when a related bit is not set. |
| `+0xA4` | u32 | bit field | File select copies it to `+0x1CA1C + 4*slot` (`0x80091450`) and tests masks from the table at `0x800F6B50` to choose icons (`0x8080ED18`-`0x8080ED30`). |
| `+0xCF` | u8 | flag | Copied to file select `+0x1CA2E`; non-zero changes the colour of the file's drawing (`0x8080EA9C`-`0x8080EAB8`). |
| `+0xEDC` | u16 | bit field | Bit 0 is cleared by a fixup in `sram_load_slot` (`0x80090A50`-`0x80090AC0`) when `+0xA4` lacks the mask `0x800F6B80`. |
| `+0xF40`, `+0xF41` | u8, 864 bytes | flag and block | When the flag is non-zero, `sram_load_slot` copies the block to the buffer at `*0x80100E30` (`0x800909E4`-`0x80090A18`). |
| `+0x12C5`, `+0x12C6` | u8, 128 bytes | flag and block | Same, to `*0x80100E34` (`0x80090A1C`-`0x80090A50`). |
| `+0x1348`-`+0x1351` | 5 x u16 | constants | Set by `save_defaults_new_file`, values above. |
| `+0x1352` | u16 | checksum | Above. |
| `+0x1354` | u32 | slot of the context (0-2, `0xFF` none) | Index of every `lhu 0x800F9E60 + 2*slot` (`0x80090BE8`, `0x80090C60`); compared with `0xFF` at `0x80090838`. RAM only: the copy loaded from SRAM holds whatever the context had. |
| `+0x1409`, `+0x140A`, `+0x140C` | bytes | language, sound, targeting | Loaded from the header by `sram_header_check`; they lie beyond the checked area and are copies of the header bytes, not per-file data. |

`sram_load_slot` also sets `+0x00` from the scene (`+0x66`): scenes 0-13 take the halfword at `0x800F9FF0 + 2*scene`; scenes 14, 15, 25, 26 and 79 take `0x41B`; 17 takes 0; 18-24 take `4, 0x28, 0x169, 0x165, 0x10, 0x82, 0x37`; 52 takes `0xBB`; 16 and every other scene fall through to the `+0x04` rule (jump table at `0x80106A30`, cases at `0x80090904`-`0x800909C4`).

### What the file select copies per slot

At boot (`0x80090F60`-`0x8009120C`) and after every create, copy or rewrite, it copies from each record into its own per-slot arrays: `+0x22` (2 bytes), `+0x24` (8), `+0x2E` (2), `+0xA4` (4), `+0x2C` (2), `+0xCF` (1), `+0x30` (2), to file select offsets `+0x1C9F6`, `+0x1C9FC`, `+0x1CA14`, `+0x1CA1C`, `+0x1CA28`, `+0x1CA2E`, `+0x1CA32`. The listing shows the name, the number from `+0x22`, the hearts from `+0x2E` and `+0x30`, and icons from `+0xA4`; nothing else of the record is read for the list.

## The sample file

`the-legend-of-zelda-ocarina-of-time-1998.1263.n64` is untrusted data and is not in the repository; `OOT_SAVE_SAMPLE` points the tests at it. 36,928 bytes (0x9040). `npm run save -- dump sample <file>` prints what follows.

### Container, by file offset

| Offset | Size | Content |
| --- | --- | --- |
| `0x0000` | 11 | `123-456-STD` (DexDrive dump header), NUL at `0x0B`. |
| `0x0010`-`0x003F` | 48 | Byte `0x12` is 1, bytes `0x15`-`0x24` are 16 x `0x03`, the rest zero. Meaning not established. |
| `0x0040`-`0x103F` | `0x1000` | Sixteen 256-byte comment slots. Slot 0 holds the NUL-terminated text "Everything done, got every skuttula(with some extras) every item/weapon and every heart container." (98 bytes); `0x140`-`0x103F` are zero. |
| `0x1040`-`0x903F` | `0x8000` | The Controller Pak image, 128 pages of 256 bytes (page *n* at `0x1040 + 0x100*n`), as described on n64brew.dev. |

Card pages, all checked on the file:

- Page 0 (`0x1040`): zero except the label area at card `+0x38`: device id `0x0001`, banks 1, then checksum `0x0101` at `+0x3C`, equal to the sum of the halfwords `+0x20`-`+0x3B`, and `0xFEFD` at `+0x3E` (`0xFFFE` minus that sum; the rule for the second checksum is inferred from this one file).
- Pages 1 and 2 (`0x1140`, `0x1240`): identical index tables. Byte 1 is `0xB1`, the sum of bytes `0x0A`-`0xFF`. Entries 5-27 point to the next page (`0x0006`...`0x001C`), entry `0x1C` holds 1 (last page); the rest of the entries 5-127 are 3 (free). Bytes 2-9 are `00 13 80 3F 75 40 00 00`, which the format leaves reserved; their content is unexplained.
- Pages 3 and 4 (`0x1340`, `0x1440`): the note table, 16 entries of 32 bytes. Entry 0 at `0x1340`: game code `3B AD D1 E5`, publisher `FA DE`, start page 5, status 0, name bytes (`0x1350`) `33 25 33 25`, extension zero. No other entry is used.
- Pages 5-28 (`0x1540`-`0x2D3F`, 6144 bytes): the note's data (chain 5 to 28). Everything after it, to `0x903F`, is zero.

### The payload

It cannot be decoded as a save:

- **No structure.** Entropy 7.966 bits per byte over 6144 bytes (a uniform random buffer of that size gives about 7.97), all 256 byte values occur, only 37 zero bytes (24 expected for random), the equal-byte fraction at every distance from 1 to 512 stays at or below 0.0063 (random: 0.0039). The equal-byte fraction at distances up to 3000 stays at or below 0.0080, so no repeating key shows. Each 512-byte block has entropy between 7.46 and 7.65. A save record, or any record of this game, has long runs of zeros and `0xFF` (`+0x40`-`+0x6F` and `+0x74`-`+0xD3` above) that no scheme except a strong cipher or a good compressor would remove.
- **Not a standard stream.** Raw deflate, `zlib` and `gzip` do not decode it at any of the first 32 offsets; the first 8 bytes `00 80 00 00 FF FF FE 6B` match no header known to the tools here (`Yaz0` is the only compression of this game, and its header is `Yaz0`).
- **The last bytes are program code.** From `0x2CE4` to the end (`0x2D3F`), the bytes decode as big-endian MIPS: a function that stores `word & 3` and `byte & 1` of the buffer into the context at `+0x140A` and `+0x140C` and calls a routine, then returns through an epilogue that restores `s0`-`s2` and `ra` from `0x18`-`0x24(sp)` and frees `0x28` bytes of stack; a prologue of the next function follows (`addiu sp,-24; sw ra,20(sp); sw a1,28(sp); or a2,a0,zero; addiu a0,a2,116; jal ...; ori a1,zero,0x8000`) and the note ends mid-function. These are the same instructions, offsets and frame sizes as `sram_header_check` (`0x800918F4`-`0x80091948`) and `sram_alloc_buffer` (`0x80091964`-`0x80091978`) in the PAL binary: `andi t1,t0,3; sb t1,0x140A(...)` and `lbu t3,1(t2); andi t4,t3,1; sb t4,0x140C(...)`. The calls point at `0x800C7BF0` and `0x800A08A8` (PAL: `0x800C7C20` and `0x800A0908`), so the code is from a different release and base, and its word at `0x2CE4` is `0x00028012` where the PAL code has `lui` with `0x8012` (`0x3C028012` shape). The bytes are program text from the cartridge's main code segment, not save data. They were read, not run.

What this leaves open: the 6,050 bytes before the code could be a compressed or enciphered window of memory or of the cartridge (the tail suggests a memory or ROM window), or deliberately random filler; the data cannot say which. Nothing in this file maps to a PAL field, so **no field is mapped and no PAL value is taken from the sample**. The "Fields that cannot be matched" list is therefore every field of the table above.

## Not established

- The meaning of the items table (`+0x74`), counts (`+0x8C`), bit fields (`+0x9C`, `+0xA4`, `+0xEDC`), `+0x2C`, `+0x68` and the constants at `+0x1348`.
- The character table of the name.
- Event, scene and other flags (the record's `+0xD4`-`+0x1347` is not read by any routine in this document; a new file leaves it zero apart from what is listed).
