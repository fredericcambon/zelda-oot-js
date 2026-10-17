# Audio: command lists, the microcode and the mixer

The game does not mix sound on the CPU. Each frame it builds a **command list** (8-byte commands) and hands it to the RSP as an audio task (task type 2); the RSP runs the audio microcode, which leaves 16-bit stereo samples in RDRAM; the game then queues that buffer to the audio interface. Our runtime never executes the microcode. `tools/audio/synth.ts` interprets the same command lists and writes the same samples. Everything below is read from this ROM; addresses are the game's virtual addresses, `ucode+0x…` are offsets into the microcode text.

Tools made for this: `tools/audio/rspdis.ts` (an RSP disassembler written from the instruction set documentation) and `tsx tools/audio/microcode.ts [data]`, which print the microcode text with its offsets or the data segment from the ROM given by `OOT_ROM`; `tools/audio/rsp-ref.ts` runs the microcode, in tests only, to check the mixer.

## From the game to the speaker

- **The task.** The builder at `0x800bb0ec`-`0x800bb170` fills the task record: type 2 at `+0x00` (`0x800bb124`), flags 0, the microcode text pointer `0x800e0f10` with size 4096 at `+0x08/+0x0c` and `+0x10/+0x14` (`lui a0,0x800e; addiu a0,a0,3856` at `0x800bb0b4`/`0x800bb0c4`, `addiu a1,zero,4096` at `0x800bb0c8`), the data segment pointer `0x801120e0` at `+0x18` and its size at `+0x1c` (`0x801123c0 - 0x801120e0` rounded down to 8, minus 1 = `0x2df`, `0x800bb0f8`-`0x800bb134`), the command list at `+0x30` (a pointer taken from a two-entry table, `0x800bb154`) and its size, `count * 8`, at `+0x34` (`0x800bb168`-`0x800bb16c`). The runtime hands `+0x30/+0x34` and the two microcode pointers to the host (`runtime/rsp.c`, `runtime/headless.c`).
- **The output buffer.** The list's last two commands interleave the left and right buffers (command `0d`) and save the result to RDRAM (command `15`; in the list of frame 2560: `0d1303c0 09400ae0`, `152603c0 8018ec00`). The caller of `osAiSetNextBuffer` (`0x800bade4`) queues the finished buffers to the audio interface (observed: buffers at `0x8018cea0`, `0x8018d9a0`, `0x8018e4a0` in rotation, 2496 to 2624 bytes each). So the host runs the command list when the task starts, the samples are in RDRAM when the game queues them, and the host copies them out when `osAiSetNextBuffer` is called.
- **The rate.** `osAiSetFrequency` (`0x800d3120`) is called from `0x800b58f8` with the first word of a per-mode table at `0x801026c8` (stride `0x38`): `32000` in the first four entries (read from the ROM). The routine divides the video clock word at `0x80006878` by the rate with a +0.5 rounding (`0x800d3154`-`0x800d316c`), refuses below 132 (`0x800d31ec`), writes `AI_DACRATE` = divisor - 1 (`0x800d3220`) and `AI_BITRATE` = min(divisor / 66, 16) - 1 (`0x800d3228`), and returns the clock over the divisor (`0x800d3234`). With the PAL clock `0x02f5b2d2` = 49,656,530 that is 1552 and a rate of **31,995 Hz**. The runtime replaces the routine (`rt_osAiSetFrequency`) and reports the rate with each buffer.

## The microcode

The text (4096 bytes, at `0x800e0f10` in RDRAM, `0xcf830` in the code file) is loaded to IMEM `0x1000`; the data segment (`0x2e0` bytes) goes to DMEM `0x000`. Disassembly (`tools/audio/rspdis.ts`) shows:

- **Start-up** (`ucode+0x000`-`0x0c0`): reads the task copy at DMEM `0xfc0` (data segment pointer `+0x18`/`+0x1c`, list `+0x30`/`+0x34`), DMAs the data segment to DMEM 0, then fetches the list in chunks of up to 64 bytes to DMEM `0x2f0` (`0x0c4`-`0x0f0`). Registers `$t8 = 0x2e0` (the **state block**) and `$s7 = 0xfb0` (the **scratch** for per-voice state) are set at `0x018`/`0x01c`.
- **Dispatch** (`0x058`-`0x084`): word 0 is in `$k0`, word 1 in `$t9`; `(w0 >> 23) & 0xfe` indexes a table of halfwords at DMEM `0x10`; `jr` to the entry. The table in the data segment reads (IMEM address - `0x1000`): 0 `f68`, 1 `230`, 2 `14c`, 3 `f18`, 4 `e2c`, 5 `4f4`, 6 `e9c`, 7 `cb0`, 8 `17c`, 9 `7cc`, a `1e8`, b `aa4`, c `b34`, d `190`, e `c5c`, f `220`, 10 `784`, 11 `830`, 12 `a20`, 13 `884`, 14 `a84`, 15 `a94`, 16 `a48`, 17 `ba0`.
- **DMA helpers** (`0xad4` read, `0xafc` write): program the SP DMA registers (`mtc0` to c0r0/1/2/3) and wait for completion. Lengths are rounded up to 8 bytes and the DMEM address is aligned down to 8 by the hardware.
- **State block** at DMEM `0x2e0`: `+0` input address, `+2` output address, `+4` byte count (all halfwords, written by command 8), `+8` loop address (written by command `0xf`).

The game sends only some of the 24 handlers. Over the intro, the title screen and the file selection (the scripted Start and A presses of the headless test, 3,560 frames), these opcodes occur: `01 02 05 07 08 09 0a 0b 0c 0d 0f 11 12 13 14 15 16`. Handler `10` (a copy, like `09`) exists but was not seen; handlers 0 (stores a record to RDRAM), 3 (multiplies two halves of a buffer), 4 (adds two buffers), 6 (reads samples through a table of positions), `e` (scales a buffer) and `17` (widens bytes) were not seen either and are not implemented: the mixer rejects them by name. All 16-bit samples are big-endian. "dmem" below means the 4 KiB working memory.

## Commands

`w0`, `w1` are the two big-endian words. "Game" cites the function that builds the command (`0x800b…`); "ucode" the handler. The reference run (below) shows each is exact.

| Op | Name | Fields | Effect |
|---|---|---|---|
| `01` | ADPCM decode | `w0` bits 16-23 flags: 1 = start from silence, 2 = take the state from the loop address (cmd `0f`), 4 = two-bit samples; `w1` = RDRAM address of the 32-byte state | decodes `count` bytes of output (command 8) from the packed input to dmem. ucode `230`-`4f0` |
| `02` | clear | `w0` low 16 = dmem address; `w1` low 16 = bytes | zeroes whole 16-byte blocks, rounded up. ucode `14c`; game `0x800b180c` |
| `05` | resample | `w0` flags (bits 16-23: 1 = start from silence, 2 and 4 = shorter history), low 16 = pitch; `w1` = RDRAM address of the 32-byte state | reads input at the command-8 input address, writes `count/2` samples to the output address. ucode `4f4`-`77c` |
| `07` | FIR filter | flags 2 and up: `w0` low 16 = byte count, `w1` = RDRAM address of 16 bytes of coefficients (load only). Flags 0/1: `w0` low 16 = dmem buffer, `w1` = RDRAM address of the 32-byte state (0 loads it, 1 starts from silence) | filters the buffer in place. ucode `cb0`-`e28` |
| `08` | set buffers | `w0` low 16 = input; `w1` high 16 = output, low 16 = byte count | stores the three halfwords in the state block. ucode `17c`; game `0x800b1890` |
| `09` | repeat a block | `w0` bits 16-23 = times, low 16 = source; `w1` high 16 = destination | loads 128 bytes from the source once and stores them `times` times in a row (at least once), 128 bytes apart (the loads at `0x7dc`-`0x7f8` sit before the loop that begins at `0x7fc`). The game sends 1 or 2. Addresses are multiples of 16 |
| `0a` | dmem copy | `w0` low 16 = source; `w1` high 16 = destination, low 16 = bytes | copies in 16-byte chunks, each read before it is written; addresses need not be aligned. ucode `1e8`; game `0x800b18d4` |
| `0b` | load codebook | `w0` low 16 = bytes; `w1` = RDRAM address | DMA to dmem `0x330`. ucode `aa4` |
| `0c` | mix | `w0` bits 16-23 = bytes / 16, low 16 = gain (s16); `w1` high 16 = source, low 16 = destination | `dst = dst * 0x7fff/0x8000 + src * gain / 0x8000`, saturated, in 32-byte steps. ucode `b34`; game `0x800b1844` |
| `0d` | interleave | `w0` bits 16-23 = bytes / 16 per channel, low 16 = destination; `w1` high 16 = left, low 16 = right | writes left, right, left, right, ... ucode `190` |
| `0f` | set loop | `w1` low 24 = RDRAM address | stores it in the state block. ucode `220` |
| `10` | copy runs | `w0` bits 16-23 = times, low 16 = source; `w1` high 16 = destination, low 16 = bytes | copies `bytes` in 32-byte steps (at least one), then continues from where the source and destination stopped for each further time. ucode `784`. Addresses are multiples of 16 |
| `11` | take every other sample | `w0` low 16 = count (outputs, in steps of 8); `w1` high 16 = source, low 16 = destination | `dst[k] = src[2k]`. ucode `830`; game `0x800b1920` |
| `12` | envelope rates | `w0` bits 16-23 = initial wet volume high byte, low 16 = wet rate; `w1` high 16 = left rate, low 16 = right rate | sets the rates and the wet volume; clears the left and right volumes. ucode `a20`; game `0x800b1944` |
| `13` | envelope mix | `w0` bits 16-23 = input / 16, bits 8-15 = samples, bits 0-7 = flags; `w1` bytes = dry left / 16, dry right / 16, wet left / 16, wet right / 16 | see below. ucode `884`-`a1c` |
| `14` | load buffer | `w0` bits 16-23 = bytes / 16, low 16 = dmem; `w1` = RDRAM address | DMA read. ucode `a84`; game `0x800b1980` |
| `15` | save buffer | same fields | DMA write. ucode `a94`; game `0x800b19a8` |
| `16` | envelope volumes | `w1` high 16 = left volume, low 16 = right volume | sets them; with 12's rates they make the ramps. ucode `a48`; game `0x800b19d0` |

### Sample format (ADPCM, command 01)

- The input is frames of 9 bytes (5 in the two-bit form) for 16 samples: a header byte then the samples. The header's high nibble is the **scale**, the low nibble the predictor index (`0x274`-`0x2c4` pick the stride 9 or 5 and the base shift 12 or 14: `0x298`/`0x29c` and `0x2b8`/`0x2bc`).
- A sample is a signed nibble (signed two bits in the two-bit form) shifted left by the scale: the microcode masks the nibbles to the top of a halfword, multiplies, and shifts right by `base - scale` (`0x340`-`0x35c`, `0x3a4`-`0x3cc`).
- The **codebook** is loaded by command `0b` to dmem `0x330`: 32 bytes per predictor, two rows of eight s16. Row 0 weights the second-to-last previous sample, row 1 the last; `0x330 + predictor * 32` (`0x310`-`0x31c`: `sll 5`, add `0x330`), row 0 loaded at `0x360`, row 1 at `0x364`.
- Each half-frame of 8 outputs: `out[i] = clamp16((in[i] * 2048 + row0[i] * p2 + row1[i] * p1 + sum over j < i of in[j] * row1[i-1-j]) >> 11)`, where `p2` and `p1` are the two samples before the half. The multiplies are `vmudh`/`vmadh` (products shifted by 16) accumulated in the 48-bit accumulator; `vsar` reads the middle and high parts and a final multiply by 32 gives the `>> 11` (`0x3f4`-`0x4c4`). The `in[i] * 2048` term is `vmadh` with the constant `0x800` of the data segment (offset `0x0a`).
- The 32-byte **state** is the last 16 output samples. A run starts by zeroing 32 bytes at the output address, loading the state there (`0x274`-`0x2f8`), decodes after them (outputs begin 32 bytes into the output buffer), and writes the last 32 bytes back at the end (`0x4e4`-`0x4ec`). The game's later commands read from `output + 0x20` for that reason.

### Resampler (command 05)

- The pitch is a fixed-point rate: one output advances `pitch * 2 / 65536` input samples, so `0x8000` is the unit rate (`vmadm v22,v25,v18[e=12]` at `0x5fc` multiplies the lane offsets `{0,2,..14}` of the data segment at `0x60` by it).
- Four input samples form each output. A 64-entry table of four s16 taps sits in the data segment at `0xe0` (the first entry, `0c39 66ad 0d46 ffdf`, sums to 32779, unity gain within 11/32768); the entry is the position's 16-bit fraction shifted right by 10 (`vmudl` by 64 at `0x60c`), 8 bytes per entry (`vmudn` by 8 at `0x610`, `vmadn` adding the base `0xe0` at `0x614`).
- The four taps multiply the four samples whose first lies at `input - 8 + 2 * integer position` in dmem. The four history samples saved by the previous run are written just before the input (`0x598`-`0x59c`: `sdv` at `input - 8`), so the window at position 0 is the four history samples.
- Each product is `vmulf` (`(a * b * 2 + 0x8000) >> 16`); the four are added in pairs, then the pairs, with saturating adds (`vadd` with lane patterns `[e=3]` then `[e=6]`, `0x6ec`-`0x724`).
- The state is 8 bytes of history, the 16-bit position fraction at `+8`, and 22 further bytes that are whatever the scratch held; the microcode saves the fraction at `0x768` and DMAs 32 bytes to the state address, and so does the mixer. Flag 1 clears history and fraction (`0x534`-`0x53c`); flags 2 and 4 store 2 or 8 history samples instead of 4 (`0x54c`-`0x558`, `0x56c`-`0x58c`).
- The game puts a decimation (command `11`) before the resampler when the pitch would exceed what the 16-bit rate holds.

### Envelope mixer (commands 12, 16, 13)

Volumes and rates are unsigned 16-bit fractions (`0xffff` ~ 1.0); a sample is multiplied with `vmudm` (`(x * volume) >> 16`). In the microcode's registers: lanes 0 and 1 hold the left volume for the first and second half of a 16-sample batch, lanes 2 and 3 the right, lanes 4 and 5 the wet volume. Command 16 sets lanes 0 and 2 and adds the left and right rates to give lanes 1 and 3 (`0xa48`-`0xa68`); command 12 sets lane 4 from `((w0 >> 16) & 0xff) << 8` and lane 5 as lane 4 plus the wet rate (`0xa20`-`0xa44`), and keeps the three rates. After each batch of 16 samples the lanes advance by twice their rates (`vaddc v1,v1,v4` at `0x9e8`).

For each batch (`0x92c`-`0x9f8`):

1. `left = (x * lane0) >> 16`, `right = (x * lane2) >> 16` for the first 8 samples, with lanes 1 and 3 for the next 8.
2. The flags build masks that the results are exclusive-ored with: left by `-(flags & 2) >> 1`, right by `-(flags & 1)`, then the wet copies by `-((flags & 8) >> 1)` (that is `0xfffc`) and `-((flags & 4) >> 1)` (`0xfffe`) (`0x8dc`-`0x914`).
3. `dryLeft += left`, `dryRight += right` (saturating).
4. The wet copies are the dry results times the wet volume (lanes 4/5), masked as above, and added to the wet buffers; with flag `0x10` the wet buffers swap channels (`0x9ac`, `0xa04`).

Samples are counted by bits 8-15 of `w0`, 16 per batch, rounded up (`0x93c`, `0x9f4`). The four buffer addresses are the high nibbles of the four bytes of `w1`, times 16 (`0x8a0`-`0x8d8`).

### FIR filter (command 07)

A filter of eight coefficients over a buffer, in place, 8 samples (16 bytes) at a time; the count of the last coefficient load applies (kept in `$t7`, `0xce8`). `out[i] = clamp16((0x8000 + 2 * sum over j of c[j] * x[i-j]) >> 16)`, with `x` before the buffer taken from the 8 samples the previous run kept (`vmacf` chain at `0xdd0`-`0xe08`). The coefficients used are the mean of the loaded ones and of the 8 s16 at state `+16`: `(0x8000 + c * 0x8000 + s * 0x8000) >> 16` (`0xd1c`-`0xd34`), and that mean is stored back at state `+16` and in the scratch. The state is 8 samples of history and the 8 coefficient means, 32 bytes. The game uses it once per voice on the resampler's output (`07020140 801975c0` then `070003c0 8019d750` in the list of frame 2560, the buffer being dmem `0x3c0`).

### Mix (command 0c) and the rest

`0xb34`-`0xb90`: `vmulf` of the destination by `0x7fff` (data segment offset `0x0c`) then `vmacf` of the source by the gain; the destination keeps the rounding of the first multiply, so a gain of `0x7fff` adds the source with a slight loss. The result is saturated.

## Reverb and the other effects

Each list begins by loading the two wet buffers (dmem `0xc80` and `0xe20`, 320 bytes each) from RDRAM with command `14` (`14140c80 801aaeb0`, `14140e20 801ac6b0`) and later saves them with `15`, so the reverb's delay lines live in RDRAM between frames. Voices add into them through the envelope mixer's wet outputs; command `0c` mixes buffers with gains (observed `0x7fff`, `0x9800`, `0xb000`, `0x00ff`) and command `0a` moves data between them. Nothing is special-cased: the mixer reproduces each command, and the reference run covers the lists that carry these effects.

## Verification

- `tools/audio/rsp-ref.ts` runs the 4096 bytes of microcode itself (scalar instructions, DMA registers, the vector unit's loads, stores, multiplies, adds, logic and `vsar`) on a command list. It is used only in tests.
- `tools/headless/headless.test.ts` boots the game, plays the intro, the title and the file selection (the scripted Start and A presses), and at 45 frames spread over that run executes the whole command list in both the mixer and the reference on the same memory. Every byte of RDRAM must be equal afterwards, including the state blocks, the delay lines and the output buffers. The reference starts from the working memory the mixer holds, because the resampler's 22 bytes of state padding are leftovers of that memory.
- `tools/audio/synth.test.ts` checks each command on synthetic data (a codebook of zeros, a unit codebook, identity filter taps, known volumes), without the ROM.
- The same test renders the title screen's audio to `out/audio/title.wav` and requires it to be audible (RMS above 300, every half second above 50) and not clipped (fewer than 0.05 % of samples at full scale). The dominant spectral peaks of the intro render are musical pitches (about 246, 262, 293, 328, 493 and 988 Hz measured at 31,995 Hz, within 0.4 % of B3, C4, D4, E4, B4, B5), which confirms the resampler's pitch.

## In the browser

`web/game.ts` runs the mixer on every audio task and posts each buffer the game queues to `web/audio.ts`, which sends it to an audio worklet (`web/audio-worklet.ts`). The worklet's `ResamplingQueue` (`web/audio-queue.ts`) converts the 31,995 Hz stream to the device rate with linear interpolation and plays slightly faster or slower (at most 5 %) to keep about 100 ms queued, since the game's clock is not the device's. Browsers start an audio context only after a user gesture, so the first key press or click starts sound; `M` mutes. In `npm run headless -- --wav out.wav` the same buffers are written to a file.

The debug overlay (the Debug button) shows the audio task count, whether sound is on and the output level. In a run of the dev page in headless Chrome (software GL), the game held 50 fps for 55 seconds (2,700 frames) while the audio context was running and the output level, measured by an analyser after the worklet, stayed between 0.02 and 0.14.
