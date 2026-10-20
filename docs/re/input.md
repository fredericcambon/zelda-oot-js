# Controllers, game state and saves

Findings from the PAL 1.0 ROM, checked by running the recompiled game headless (`tools/headless/headless.test.ts`). Addresses are main-code-file RAM addresses.

## Controller path

- The pad thread (thread id 7, entry `0x800A3058`, priority 14) is created by the routine at `0x800A3140`-`0x800A3230` (the entry address is built by `lui/addiu` at `0x800A320C`/`0x800A3210`). Its init adds a client record (`+112` of its state at `0x8011B320`) to the client list at `+0x248` of the retrace dispatcher (`0x800AD4C0`, called at `0x800A31A4`; the list is read from RAM at `0x8011B9D0`). The thread waits on its own queue (`osRecvMesg` at `0x800A30B0`) and calls `0x800A2D1C` for a message whose type halfword is 1 (`0x800A30C0`, `0x800A30E4`).
- `0x800A2D1C`: takes the serial-interface access from the lock queue (`0x800A2740`), calls `osContStartReadData` (`0x800D09D0`, call at `0x800A2D38`), waits for the completion on the serial queue (`0x800A2D5C`), calls `osContGetReadData` (`0x800A2D68`), then `osContStartQuery` (`0x800D1660`, `0x800A2DA8`), waits again (`0x800A2DB8`) and calls `osContGetQuery` (`0x800A2DC0`). It is the only caller of `osContStartReadData`.
- The routine at `0x800A2A40` runs `0x800D0474` once per channel (loop `0x800A2A84`-`0x800A2AAC`, four channels) and skips the call at `0x800A2AA0` when the result is non-zero. `0x800D0474` is `osPfsInit`: it selects pak banks and reads the pak through the serial interface (`os_internal_cont_ram_read`, `0x800D4B70`), whose completion is raised by the console's serial-interface interrupt. The runtime has no such interrupt, so the thread waited forever on the serial queue after the first iteration and the game never read a pad again (observed: `osContStartReadData` called once in 600 frames, the button words at `0x8011B550` and `0x8011B5B0` frozen). `rt_osPfsInit` (`runtime/cont.c`) answers with the non-zero "no pak" code, as no pak is ever plugged in; the pad is then read once per retrace.
- Pad data reaches the game through the `OSContPad` array the game passes to `osContGetReadData` (array at +656 of the pad thread's state: `0x8011B5B0`). The button halfword is what the host sets with `oot_pad_set`.

## Buttons

Bits of the halfword, as observed by driving the game: `0x1000` at the title screen starts the transition to the language screen; `0x8000` selects English and then a file slot. The other bits follow the layout of the SDK manual's `OSContPad` (A `0x8000`, B `0x4000`, Z `0x2000`, Start `0x1000`, D-pad `0x0800`-`0x0100`, L `0x0020`, R `0x0010`, C buttons `0x0008`-`0x0001`).

## Game state: the file select overlay

The main code file's data holds a table of 0x30-byte records for the game's state overlays, at `0x800EF2C4`, `0x800EF2F4`, `0x800EF354` and `0x800EF384` for files 31, 30, 32 and 33 (found by the descriptor scan in `docs/re/overlays.md`). Each starts with the ROM range of its file, then the link range, a zero word, the init and destroy routines (link addresses) and, at `+0x28`, the instance size.

File 33 (virtual ROM `0xBA0A00`-`0xBB10E0`, link range `0x80803880`-`0x80813F90`, instance size `0x1CAE0`) is loaded when Start is pressed at the title (the ROM read of its file appears at frame 2522 of a boot where Start is pressed at frame 2450). At that moment the loader rewrites the record's init word at `0x800EF398` from the link address `0x808127AC` to the loaded address (`0x803B381C` in the headless run, overlay loaded at `0x803A48F0`) and the destroy word at `0x800EF39C` likewise. The headless test uses this word as the proof that the file selection was reached: it holds `0x808127AC` at the title and a loaded address afterwards.

The screens of this overlay, in the PAL ROM: language selection first (English, Deutsch, Français), then "Please select a file." with File 1-3, Copy, Erase and Options, then the name entry. A frame of each is dumped by the test to `out/input-frames/`.

## Saves

Save data lives in the cartridge's SRAM window (`docs/re/os-routines.md`, `sram_transfer`). The runtime keeps it in `rt_sram` (0x20000 bytes) and flags it dirty on every write; the host reads it with `oot_sram` / `oot_sram_take_dirty`. Naming a file and confirming it in the headless run writes the save memory (flag set between frames 3470 and 3560), and a second boot given those bytes lists the file on the selection screen instead of an empty slot. The page stores the bytes in IndexedDB (`web/saves.ts`) after every frame in which the game wrote them and restores them before the first frame.

## Z-targeting setting

The ROM has a two-state targeting option on the options screen of the file select overlay (file 33, `ovl_0033`). The setting is the byte at `0x801183D0 + 0x140C` (`0x801197DC`; header byte 1, see `docs/re/saves.md`). The only stores to that offset outside the save routines (`sb` at `0x80091914` in `code`, and `0x80aedeb8` in file 362, which zeroes it) are two in file 33, at `0x80809144` and `0x80809208`: each loads the byte (`lbu` at `0x80809138` and `0x808091fc`), applies `xori 1` and stores it back, so a confirm on that row of the options screen flips the byte between 0 and 1 (the neighbouring row cycles the sound byte at `+0x140A`, 0 to 3). The routine at `0x8080a0a4` (and `0x80809068`) reads the byte again to choose what the row shows. The byte is persisted by the header write (`sram_header_write`). Which word names which value was not read from the texture data here; the choice itself, a two-way toggle, is proven by the instructions above.
