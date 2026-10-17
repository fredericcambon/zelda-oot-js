# Save memory: layout, record, checksum, and the sample file

Evidence from the PAL 1.0 ROM (SHA-1 `328A1F1BEBA30CE5E178F031662019EB32C5F3B5`). Addresses are virtual; `npx tsx tools/analyze/disasm.ts code <start> <end>` lists them. Names are our labels for addresses, not claims about the original. A statement marked *observed* comes from running the built game on a save image (`tools/saves/game.test.ts`), not from reading code alone.

`npm run save -- dump sram <sram.bin>`, `verify`, `new`, `set` and `import` implement this document (`tools/saves/sram.ts`, `record.ts`, `image.ts`).

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
| `+0x68` | 10 bytes | bytes `+0x68`-`+0x6B`, halfword `+0x70` | Template at `0x800F9EC4`: `FF` x7, `00 11 00`. `0x80090AA4`-`0x80090AC0` scan `+0x69`-`+0x6B` for the value `0x23` and replace it by `0x22`. |
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

## Building and editing saves

`npm run save -- new --slot N --name <name> --out <sram.bin> [--in <sram.bin>] [field=value...]` writes a new file (both copies, checksum sealed) into a fresh 128 KB image, or into `--in`. `set <sram.bin> --slot N field=value... [--out <file>]` edits a file in place. `import <file> --out <sram.bin>` takes a raw save memory image of 32 KB to 128 KB and accepts it only when `verify` accepts it as is; a DexDrive dump is reported unsupported. Every `new`/`set` edit is validated, applied to a copy and sealed with the game's checksum; the command exits 1 when `verify` would not accept the result. `dump sram` adds a `decoded` view of the fields below.

A new file is the record `sram_create_file` writes: the 76, 10 and 96 bytes `save_defaults_new_file` copies from `0x800F9E78`, `0x800F9EC4` and `0x800F9ED0` to `+0x1C`, `+0x68` and `+0x74` (`0x80090590`-`0x800906A8`), the constants of "New file" above, the marker and the name. Template bytes: `+0x2E`/`+0x30` `0x0030`, `+0x33` `0x30`, `+0x40`-`+0x46` and `+0x4A`-`+0x50` `FF`, `+0x66` `0x0034`, `+0x68`-`+0x6E` `FF`, `+0x70` `0x1100`, `+0x74`-`+0x8B` `FF`, `+0x9C` `0x1100`, and `FF` x 19 further on in the `+0x74` block. `tools/saves/game.test.ts` compares the record built here with the one the game writes.

| Field | Record | Evidence |
| --- | --- | --- |
| `name` | `+0x24`, 8 bytes | Character codes: `0`-`9` are `0x00`-`0x09`, `A`-`Z` `0x0A`-`0x23`, `a`-`z` `0x24`-`0x3D`, blank `0x3E`, `-` `0x3F`, `.` `0x40`. *Observed*: the file select draws a name character from a 16 x 16, 4-bit intensity texture at `fileSelect + 0xE760 + 15496 + 128 * code` (`0x8080E8FC`-`0x8080E914`: `lbu` of the code, `sll 7`, `addiu 15496`). Read from RAM after a new game, codes `0`, `1`, `9`, `0x0A`, `0x0B`, `0x23`, `0x24`, `0x25`, `0x3D` render as `0`, `1`, `9`, `A`, `B`, `Z`, `a`, `b`, `z`; `0x3F` renders as a dash, `0x40` as a dot, `0x3E` as nothing. The first key of the scripted name entry produced `0x0A`. |
| `hearts`, `health` | `+0x2E`, `+0x30` | Above. `hearts=N` sets both to `16 * N`; `health` is in hearts and may be fractional. |
| `count34` | `+0x34`, s16 | The routine (function `0x8007888C`-`0x8007958C`) reads it with `lh 52` (`0x80078D7C`), clamps an increase to the capacity read from the table below (`slt` at `0x80078D88`, `sh 52` at `0x80078DD4`) and a decrease at zero (`0x80078DE0`-`0x80078E14`). |
| `limit34` | `+0xA0` bits 12-13 | The same routine loads `+0xA0` (`0x80078D54`), ANDs the mask `0x00003000`, the first word of the table at `0x800F6BF0` (`0x80078D58`), shifts by the byte `0x0C` at `0x800F6C28` (`0x80078D60`) and indexes the halfword table at `0x800F6C4C`: 99, 200, 500, 500. `set` refuses a `count34` above the capacity of the chosen `limit34` (0-3). The other fields of the word (3-bit fields at bits 0, 3, 6, 9, 14, 17, 20, from the masks at `0x800F6BF0` and the shifts at `0x800F6C24`) are not edited. |
| `items.<slot>`, `item=<id>` | `+0x74`, 24 bytes, `FF` empty | The item-give routine `0x8007039C`-`0x80071A18` takes the id as byte `55($sp)`, finds the slot in the byte table at `0x800F6E94` (`0x800703B4`-`0x800703C0`) and stores the id at `+0x74 + slot` (`sb 116(...)`, `0x80071A04`). The table has 56 entries (ids 0-55; the range test `slti 56` is at `0x80071944`): ids 0-7 slots 0-7, 8 slot 7, 9 slot 8, 10-11 slot 9, 12-19 slots 10-17, 20-32 slot 18 (the routine puts these in the first free slot of four from slot 18, `0x800718F8`-`0x80071930`), 33-44 slot 23, 45-55 slot 22. `item=<id>` stores by this table; `items.<slot>` stores the raw id. What each id is called is not established. |
| `counts8C.<i>` | `+0x8C`, 16 bytes | Ids 3 and 72-79 store a count byte at `+0x8C + slot` (`0x800707F0`-`0x80070800`, `sb 140(...)`), clamped by a halfword table indexed by a field of the word at `+0xA0`. The table has 16 bytes, so `set` accepts slots 0-15; the bytes after it are the equipment word and the upgrade word. |
| `equip0`-`equip3` | `+0x9C`, `+0x70`, `+0x68` | Ids 59-70 (`0x80070530`-`0x800706E0`) set one bit of the halfword `+0x9C`: the bit is `1 << (id - 59 - 3 * group)` (table of single bits at `0x800F6B50`), shifted by the byte `0x800F6C20 + group` (0, 4, 8, 12). So four groups of three, one nibble each. The groups carry no names: nothing in the binary here says what an index is. The only behaviour found: group 0 writes its item id to `+0x68` (`sb 60,104(t0)`, `0x800705E4`; id 61 also tests the full nibble `0xF`) and sets the low nibble of `+0x70` to 2 (`0x800705E0`-`0x800705F8`), so each nibble of `+0x70` holds the index plus one (new file `0x1100`: groups 2 and 3 at 1). `equip0=n` sets bit `n - 1` of nibble 0 of `+0x9C`, nibble 0 of `+0x70` to `n` and byte `+0x68` to id `58 + n`; `equip1`-`equip3` set the bit of their nibble in `+0x9C` and the nibble of `+0x70`. 0 clears the nibble of `+0x70` (and `+0x68` for `equip0`); the `+0x9C` bit stays. 0 unequips (the owned bit stays). |
| `byte68.<0..3>` | `+0x68`-`+0x6B` | `sram_load_slot` scans `+0x69`-`+0x6B` for id `0x23` (`0x80090AA4`-`0x80090AC0`); `+0x68` is written by the id-60 case above. The bytes `+0x6C`-`+0x6E` (`FF`) are left alone. |
| `bitsA4.<bit>` | `+0xA4`, u32 | Ids 102-107 OR the bit `id - 102` (`0x8007040C`-`0x80070428`, the table of single bits at `0x800F6B50` read at `0x800F69B8 + 4 * id`), ids 90-101 the bit `id - 84` (`0x8007044C`-`0x80070474`), ids 108-112 the bit `id - 90` (`0x80070488`-`0x800704B0`, `0x800704C4`-`0x800704EC`), id 113 the bit 23 and also adds one to the halfword `+0xD0` (`0x80070510`-`0x8007052C`). The file select tests bits 0-7 for its icons (`0x8080ED18`-`0x8080ED30`). *Observed*: bit 0 draws a green round icon on the file. What each bit stands for is not established beyond this mapping from ids. |
| `countD0` | `+0xD0`, u16 | Increased by one with the id 113 above; the file select's three-digit number is `+0x22`, a different field. |
| `flag3A`, `flag3C` | `+0x3A`, `+0x3C` (bytes) | The routine at `0x80079148`-`0x80079170` sets byte `+0x32` to byte `+0x3C` plus one when `+0x3A` is non-zero and `+0x32` is zero. The handler that loads a chosen file zeroes `+0x33` and `+0x32` (`sb zero,51` at `0x8081160C`, `sb t0,50` at `0x808116BC`, the register holding the zero just read back from `+0x33`), so `+0x33` and `+0x32` in a file do not carry over: the level is rebuilt from these two bytes. `dump` shows `+0x32` and `+0x33` as `level32` and `byte33`; `set` does not write them. The new file's `+0x33` is `0x30`. |
| `flag04` | `+0x04` | 0 or 1. 1 is the new file's value; non-zero selects entrance `0xBB` (the house of scene 52) and zero `0x5F4` where the scene has no case of its own (`0x80090990`-`0x800909C4`). What the flag means is not established. |
| `scene` | `+0x66` | The scene Link resumes in. `set` also writes `+0x00` with the entrance `sram_load_slot` will compute (`entranceFor` in `record.ts`, the rules under "Record fields"); the game overwrites `+0x00` itself at load. Scenes are not checked against the scene table. `set scene=` clears the cutscene index at `+0x08`, because a file built by `new` and moved to another scene would keep the new-file cutscene index `0xFFF1` at `+0x08`; loaded through the file select, the game then enters the cutscene layer of the entrance, table entry `index + 5`, which for scene 5 (index `0x10`) is entry `0x15`, scene 110, and the run stops with `PI access to unmapped cartridge address 0x00d91e80` (reproduced in a headless run that put `0xFFF1` back at `+0x08` after applying the record; the test in `tools/headless/load-save-rom.test.ts` plays the same record with `+0x08` cleared). "Load slot N into play" clears `+0x08` first, so it reaches scene 5. `new` alone keeps `0xFFF1`: it is the value the game writes, and in the house it selects the opening cutscene. |

*Observed*, on a file built with `new` (`hearts=12`, `bitsA4.0`): the file select's "Open this file?" screen shows the name, twelve hearts and the icon of `bitsA4` bit 0 (frame 2880 of the scripted boot, the A of frame 2700 having selected the file).

## Loading a save into the running game

`tools/headless/load-save.ts` (used by the page, `web/save-actions.ts`, and by `tools/headless/load-save-rom.test.ts`) does two things. Both run between two frames.

**Put a record in play** (`loadRecordIntoPlay`). Allowed only when `unsafeReason` finds nothing; it answers, with the evidence:

| Check | Evidence |
| --- | --- |
| A scene is loaded | The play context pointer at `0x80112BE0` is set and the scene loader's record is at the context's `+0x1242C` (`playState` in `tools/headless/state.ts`). Zero at boot and while the file select runs (observed at frames 200 and 2600-2800 of a boot). |
| Not the title | The word at `0x8011972C` is 1 while the title's demo scene (81) runs, 2 in the file select, 0 in play (observed by frame). The play state's exit tests it (`0x8009BB9C`, `0x8009BBA8`): 2 selects the file select's init `0x808127AC` with size `0x1CAE0` as the next state, anything else the play state. |
| Not ending | The play context's `+0x98` is the running flag the exit clears (`0x8009BB98`). |
| No scene transition | Bytes `+0x11E15` and `+0x1241B` of the play context (`lb 7701` and `sb zero,9243` on the context plus `0x10000`, `0x8009BA94`, `0x8009BC2C`). Observed in the new game: `0xEC` and 17 while a scene fades in, 0 and 0 once Link is under control; any other value is refused. |

Then it copies the first `0x1354` bytes of the record to the save context, sets the context's slot word (`+0x1354`) to the slot, zeroes `+0x32` and `+0x33` and raises a health below `0x30` to `0x30` (the file select's load does the same, above), sets `+0x08` to 0 and the pending cutscene halfword at `+0x1410` to `0xFFEF`, and ends the play state into a new one at entrance index `entranceFor(scene, flag04)` with the sweep's mechanism (`requestEntrance`). The init adds its setup variant (from the time of day and `+0x04`) to the index, so a plain day or night is entered, not a cutscene layer. *Observed* with `tools/headless/load-save-rom.test.ts`: from a settled scene, a record with 12 hearts, an item and the name `Epona` in scene 85 with `flag04` 0 puts Link in the scene of table entry `0x5F4 + 2` with those hearts, item and name, and a record in scene 5 runs 300 frames.

**Start over** (`oot_reset`, `Game.reset`). It runs `oot_boot` again on the cartridge image it already holds: RDRAM, threads, devices and the clock restart, and the save memory is kept (`rt_reset` resets `pi` flags only, not `sram`). The page writes the new save memory first, so that `sram_verify_all` and the file select read it. Start pressed at the title (`AutoStart`: every 50 frames from frame 100, held 6) takes the game to the file select, where the overlay's record at `0x800EF398` changes from the link address (first seen at frame 473 of a boot). *Observed*: the file select then lists the replaced file.

Why not end the running play state into the file select directly, as the play state's own exit does with the word at `0x8011972C` set to 2: *observed*, the file select then appears and lists the current save memory, but afterwards ignores every button (A, B, Start, D-pad), whether started from the new game's house or from the first frames after loading a file; started from the title's demo scene it works. Something the in-game scenes leave behind keeps the input from reaching it; it was not found, so the page restarts instead.

## Import of the sample

`import` does not read the sample: its payload does not decode (below), so no field is mapped. The unmapped fields are every row of the field table of "Record fields" (`entranceIndex`, `flag04`, `cutsceneIndex`, `timeOfDay`, `magic`, `counter22`, `name`, `field2C`, `healthCapacity`, `health`, `sceneIndex`, `bytes68`, `itemSlots`, `counts8C`, `bits9C`, `bitsA4`, `flagCF`); `import` prints this list when given the sample. A raw save memory image of 32 KB to 128 KB is imported unchanged when `verify` accepts it as is (PAL signature, language and checksums); any other image is refused as unsupported.

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

- What each item id, equipment index and quest bit is called (the structure of `+0x74`, `+0x8C`, `+0x9C`, `+0x70`, `+0xA0` and `+0xA4` is established above; the names are not), the other fields of the upgrade word, the magic capacity per level, `+0xEDC`, `+0x2C`, `+0x6C`-`+0x6E` and the constants at `+0x1348`.
- Event, scene and other flags (the record's `+0xD4`-`+0x1347` is not read by any routine in this document; a new file leaves it zero apart from what is listed).
