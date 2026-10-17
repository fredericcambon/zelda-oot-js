# TV type and the 60 Hz mode (PAL 1.0)

Evidence is from the PAL 1.0 ROM (SHA-1 `328a1f1beba30ce5e178f031662019eb32c5f3b5`); addresses are virtual. Listings: `npx tsx tools/analyze/disasm.ts <boot|code> <start> [end]`. The readers below were found with `npx tsx tools/headless/lowmem-scan.ts 80000300`, which lists every instruction of every image (boot, main code, segments, overlays) that reaches a low-memory word through `lui rX, 0x8000` and an offset (loads, stores, `ori`, `addiu`, within 24 instructions of the `lui`).

## Where the TV type is set

Nothing in the ROM writes the word at `0x80000300`; the console's boot stage does (`boot-flow.md` section 1). The runtime writes it in `rt_boot_state` (`runtime/osinit.c`): 0 for the 50 Hz boot (PAL), 1 for the 60 Hz boot (NTSC). The code tells apart only the values 0, 1 and 2 (below).

## Every reader

Eight instructions read it, in five routines. No overlay and no segment reads it.

| Reader | Routine | What it switches |
| --- | --- | --- |
| `0x8000067C` (`lw v0, 0x300`), branches at `0x80000688`, `0x80000694`, `0x8000069C` | the first thread's entry, `0x8000063C` | For 0, 1 and 2 (anything else skips to `0x80000700`): copies `0x48` bytes from `0x80006A00` to `0x800082F0` (`0x800006C0`-`0x800006F4`) and stores the float at `0x80006A88` (0.833, `0x3F553F7D`) to `0x80006724` (`0x800006F8`-`0x800006FC`). The `0x48` bytes are an `OSViMode` record with PAL timing (type `0x2C`, vsync `0x271`, burst `0x04541E3A`). The thread then calls `osViSetMode` (`0x80003EC0`) with `0x800082F0` (`0x80000704`) and `0x800007E0(1)` (`0x8000070C`). The three values act alike. |
| `0x80000800`, `bnel` at `0x80000808` | `0x800007E0(a0)`; callers `0x8000070C`, `0x8007D270` and `0x800A3338` pass 1, `0x800A3300` passes 0 | With `a0 != 0`: TV type 0 calls `osViSetMode(0x800067D0)` (the PAL mode, `0x80000810`), other types skip it; both then call `osViSetYScale(1.0)` (`0x80006330`, `0x80000820`). With `a0 == 0` the TV type is not read and `0x800082F0` is set (`0x80000830`). |
| `0x800033DC`, `0x80003400` | `osInitialize` | The video clock word at `0x80006878`: 0 stores `0x02F5B2D2`, 2 stores `0x02E6025C`, anything else `0x02E6D354` (`0x800033E8`-`0x80003430`). |
| `0x800053E0`, `0x80005408` | `osViInit` (`0x80005370`, called at `0x80005FF4`) | The first VI mode of the next context (`+8`): 0 gives `0x800067D0` (type `0x10`, vsync `0x271`), 2 gives `0x800069A0` (type `0x1E`, vsync `0x20D`), anything else `0x80006950` (type `0x02`, vsync `0x20D`). |
| `0x80093CA8` | the video config initialiser (`0x80093C6C`-`0x80093CD0`) | Stores the TV type at `+108` of the config record that the update routine reads (`0x80093CC0`). |
| `0x80094018` | the routine that applies the video config (it contains `0x80093FF0`-`0x80094098`) | Passes the TV type as the third argument of `0x8009355C` (call at `0x80094058`). That routine builds an `OSViMode` and compares the TV type with 1 (`0x80093854`), 0 (`0x80093898`) and 2 (`0x800938F8`): NTSC gets burst `0x03E52239`, vsync 524, hsync 3093 (`0x8009385C`-`0x80093894`), PAL gets burst `0x0404233A`, vsync 624 (`0x800938A0`-`0x800938F0`), MPAL burst `0x04651E39`, vsync 524, hsync 3088. It also nudges vertical start words by TV type (`0x800939B0`-`0x80093A18`). |

Everything the TV type switches is therefore the video interface (mode records and clock) and, through the clock, the audio interface rate. Nothing reads it for timers, movement, retrace counts or the sound engine.

### What is not switched by it

- The game's pace is three retraces per graphics task, which does not depend on the TV type. At 50 Hz that is 16.7 game frames per second, at 60 Hz 20.
- The audio engine is calibrated for 50 retraces per second regardless of the TV type: the audio context's refresh rate is the constant 50 (`addiu t6, zero, 50`, `sw t6, 10596(s2)` at `0x800B8D84`-`0x800B8D88`, into `0x80125FB4`), read at `0x800B5904` to size a frame (`(32000 / 50 + 15) & ~15` = 640 samples, `0x800B5910`-`0x800B591C`), and the tempo constant is the float 20.03042 (`0x801077D0`, loaded at `0x800B8D80`).
- In a run of 19,000 retraces in either mode, the VI context's mode pointer stays at `0x800082F0` (the record the first thread installs) after retrace 30, so the mode that `0x8009355C` builds never reached the video interface in that flow. At retrace 2 the pointer is `0x800067D0` at TV type 0 and already `0x800082F0` at TV type 1.

## Candidate 1: NTSC TV type, 60 Hz retrace, frame pacing at 1/60 s

Used. `rt_set_vi_hz(60)` (`runtime/vi.c`) makes the VI retrace every 781,250 Count ticks and `oot_frame` advance by the same, and `rt_boot_state` writes TV type 1. The page and the headless runner choose it before boot (`oot_set_hz`). Nothing else changes.

Measured with the scripted new game (`tools/headless/newgame.input`: title, file creation, the opening with the castle and Kokiri Forest scenes, Link's house, walking), the same script in both modes:

| | 50 Hz | 60 Hz |
| --- | --- | --- |
| trap, hang or unknown display-list command | none | none |
| graphics tasks per second of virtual time, steady (retraces 9,000-18,000) | 16.67 | 20.00 (within 0.2 %) |
| audio tasks per second | 50.0 | 60.0 |
| audio interface rate | 31,995 Hz | 32,006 Hz (the NTSC clock over the same divisor) |
| audio produced per second of virtual time | 31,995 frames | 32,000-32,015 frames |
| audio buffers | about 50 a second, 2,496-2,624 bytes | 60 a second, 2,112-2,240 bytes (one per audio task) |
| buffers queued after the interface ran dry (`oot_ai_gaps`) | 0 | 0 |

The sound engine needs two constants changed for this (next section); without them the table's 60 Hz audio column would not hold.

Pitch and tempo, measured on the title music of each mode, recorded before the script presses a key (`tools/headless/spectrum.ts`):

- Pitch: the average spectra of the two recordings have cosine similarity 0.90 over the 20-800 bin range when compared as they are and at most 0.57 when one is stretched by 0.8, 0.9, 1.1 or 1.2.
- Without touching the sound engine, 60 Hz sounds wrong: the engine sizes each audio task for 50 tasks a second (640 frames, from the refresh rate constant) and runs 60, so the game queues only about 50.5 buffers a second and the output of about 10 tasks a second is never played. Measured on the title music, the second difference at the joins between buffers is 410 against 72 at 50 Hz and 66 samples in 45 s jump by more than 6000 against 5. The music also runs 1.20 times faster in real time (loudness envelope match, correlation 0.92), because its sequences advance once per task.
- What the 60 Hz boot does about it: `rt_osAiSetFrequency` (called at `0x800B58F8`, before the engine reads the two words at `0x800B5904` and `0x800B5A68`) sets the refresh rate at `0x80125FB4` to 60 and multiplies the tempo divisor, the float 20.03042 at `0x80125FB0`, by 5/6. Tasks then make 544 frames, one buffer each, 60 a second (2,112-2,240 bytes); the join measure is 78 against 72 at 50 Hz; and the loudness envelope matches the 50 Hz one at speed 1.00 (correlation 0.88), so the music keeps its 50 Hz real-time tempo while the game runs 1.2 times faster. Only the refresh rate (tempo 1.20) or only the divisor (clicks) is not enough. This is a runtime edit of game data, not an NTSC path of the game, which has none. The music is no longer in step with the picture in cutscenes as it is at 50 Hz.

### Fallback: not implemented

The alternative (60 frames per real second of the PAL game at its 50 Hz virtual clock and a pitch-keeping time stretch of the audio) is only needed if the NTSC boot breaks the game or the audio. It does not: no trap, the pace is exact, the audio interface stays consistent, no gaps, pitch unchanged. It is not implemented.

## Using it

- Page: the "60 Hz" button next to Debug stores the choice in `localStorage` and applies at the next page load (the TV type is read once at boot; a running game cannot change it). The page says so next to the button and does not reload.
- Headless: `npm run headless -- --hz 60 ...`; `bootGame(url, rom, { hz: 60 })`.
- Save states record the mode they were taken in (`X-Hz` on the saves endpoint). A state of the other mode is refused with a message.
- Test: `tools/headless/headless.test.ts` ("plays the new game in 60 Hz mode ...", needs `OOT_ROM`).
