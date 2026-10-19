# Assets: classification of the file table and the formats inside (PAL 1.0)

`npm run port` writes `dist/assets/<type>/<index>-<virtual start>.bin` and `dist/assets/manifest.json`. Code: `tools/assets/`. Every number below was read from this ROM; the addresses are main-code-file RAM addresses unless stated. Display-list command layouts are in `display-lists.md`, the file table in `rom-layout.md`, overlays in `overlays.md`.

## Storage

- Each entry holds the **stored bytes** of one ROM range (a Yaz0 stream stays compressed). The game decompresses through its own DMA manager (`dma_serve_request`, `os-routines.md`), reading the cartridge by PI DMA from a flat image, so the runtime needs the raw bytes; pre-decompressing would need changes to the game's loader.
- The entries tile the whole image: the header and boot area (file 0 and 1), the file table (inside file 2), every file, and the ROM ranges no record names (`unknown`, reason in the manifest). `tilingProblem` rejects gaps and overlaps; the ROM-gated test rebuilds the image from the manifest and checks SHA-1 `328a1f1b...5f0d2d` and byte equality.
- `manifest.json`: `rom` (SHA-1, size), `entries[]` in ROM order with `file`, `path`, `romStart/romEnd`, `virtualStart/End`, `compressed`, `type`, `label`, `confidence`, `evidence[]`, `reason` (unknown entries), `contents` (offsets are in the decompressed file), plus `tables[]` (the tables below with their readers) and `summary`. The page and the headless runner both rebuild the image from it (`web/cartridge.ts`, `tools/assets/write.ts`).

## Result

469 overlays, 380 objects, 101 scenes, 388 rooms, 121 textures (title cards and image/palette pairs), audio (1 bank file, 1 sequence file, 1 sample table), 1 animation file, 4 text files, 3 code files; 39 entries stay `unknown` or `other`, each with its reason.

## Evidence per type

- **Overlays.** Descriptor tables in the main code file (`overlays.md`), footer validated in all 469.
- **Objects.** 402 records `{virtual start, virtual end}` at `0x800F6F58`; the word before it (`0x800F6F54`) is `0x192` = 402. Record 0 and removed objects are empty ranges. Readers: `0x8007C6B4` (indexes `table + id*8`, calls `rom_file_load` at `0x8007C6F8`/`0x8007C730`), `0x80081AE0` (object slots, `dma_request_send` at `0x80081B74` with `end - start`), `0x80081C68`, `0x800818C4`. The file's pointers use segment 6 in 135 of them (majority of in-file pointers in their display lists).
- **Scenes.** 100 records of 20 bytes `{scene start, end, title start, end, 4 bytes}` at `0x800F9440`, indexed `id*5*4` by `0x8009D640` (`0x8009D65C`-`0x8009D668`), which loads `[+0, +4)` with `0x8009D438` (allocate `end - start`, `rom_file_load` at `0x8009D478`). The byte at `+0x11` is copied to the scene context and indexes a table of draw routines at `0x800F9C78`.
- **Scene and room headers.** 8-byte commands ending with id `0x14`, run by `0x80081D50`: ids below 26 call `table[id]` (`jalr` at `0x80081DA0`, table `0x800F6ED0`, 26 words, entry `0x14` empty). Command 4 (handler `0x80082080`) stores byte `+1` (count) and the pointer `+4` of the command; the room loader (`0x80081118`: `dma_request_send(dst, pairs[room*8], end - start)`) reads `{start, end}` pairs from it. Each of the 388 rooms is named this way.
- **Title cards.** Scene record `+8/+0xC` names a file; 57 exist (which scenes show them: `title-cards.md`). File 886 (size `0x2880`) decodes as IA8 144x72 and shows the scene name in three languages; all 0x2880-byte ones decode with neighbouring-texel smoothness 0.54-0.95 (random bytes: 0.00).
- **Audio.** Three index tables in the code data, each `{s16 count, s16 medium, u32 base = 0, 8 bytes}` + 16-byte records `{offset, size, medium, ...}`: `0x80111540` (38 records, ranges fill file 3), `0x80111970` (110, file 4), `0x80112060` (7, file 5). `0x800B77A8` stores the file's ROM address in `+4` and adds it to each offset; the set-up at `0x800B8F54`-`0x800B8F88` passes each table with `0xD8C0`, `0x39680`, `0x89100`. Roles: records of table `0x80111540` carry a byte at `+10` in `0..6` (an index into the 7-record table, `0xFF` at `+11`) so file 3 holds banks and file 5 the sample data; file 4 is the remaining table (sequences).
- **Animations.** Header `{s16 frames, 0, u32 frame data, u32 joint indices, u16 static index max}`: the sampler at `0x8008A5D0`-`0x8008A720` reads `+4`, `+8`, `+0xC`; indices below `+0xC` read a constant, others the frame. File 6 holds per-frame data for the player: `0x8008BB20`-`0x8008BB78` fetches `(limbs*3*2)+2` bytes at `0x4DA490 + offset + frame*size` with `dma_request_send`.
- **Textures inside files.** `dlscan.ts` follows SETTIMG / SETTILE / LOADBLOCK / LOADTLUT / SETTILESIZE (formats and sizes as in `display-lists.md`) in the display lists found by structure; `contents.textures` gives format, size, palette and offset. Standalone image/palette pairs (files 962-1005: body of `N * 0x10000` bytes and `N * 0x200` of palette) decode as CI8 256x256 pictures with RGBA16 palettes.
- **Text.** Files 21-23 are ~90% printable ASCII in three languages.

## Not classified

`unknown` entries are named by a constant or table in code but match no layout (e.g. files 7 and 8 are read in `0x1000`/`0x900`-byte blocks by `0x800701A8` and `0x800D955C`), or are named by nothing. File 938 holds display lists in a different opcode set (`B8`-terminated), not interpreted.
