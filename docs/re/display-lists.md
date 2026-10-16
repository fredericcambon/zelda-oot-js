# Display lists and graphics tasks (PAL 1.0)

What the game hands to the RSP for drawing, and how `tools/gfx` turns it into draw batches. Everything here was observed in this ROM running headless (`npm run headless -- --frames 600 --dl`, 345 graphics tasks, 568,824 commands, no unknown command). Command layouts are derived from the words the game writes and from the data they point at; the hardware (RDP) command fields were additionally checked against the public RDP command descriptions on n64brew.dev. No microcode source was consulted: the RSP never runs, only the layouts below matter.

Method: the runtime passes the memory image to a host callback at the moment the game starts a graphics task (`Module.onGfxTask`, `runtime/headless.c`), so the lists and the data they point to are read exactly as the game left them. Code addresses are in the main code file as loaded at `0x80001000+`.

## 1. The graphics task

`osSpTaskStartGo` receives a task record whose layout is in `runtime/rsp.c`. For a graphics task (type 1) the first task of the run is at `0x8011D130`:

```
0x8011D130  00000001 00000004  type 1, flags 4
0x8011D138  80006560 00000160  boot ucode, size
0x8011D140  800E1EC0 00001000  ucode, size
0x8011D148  801123C0 00000800  ucode data, size
0x8011D150  80168280 00000400  DRAM stack, size
0x8011D158  8014F680 80167680  output buffer, end
0x8011D160  8017A588 00000008  data pointer, size 8
```

The data pointer holds a single command, `DE010000 80168688`: a branch to the real list (§3). The data size is the size of that one command, not of the list, so the interpreter ignores it and follows the commands until the list ends. The microcode pointers are not used (the RSP is not executed).

Every list ends with `E9000000` (RDP full sync) followed by `DF000000` (end of list): 345 `E9` for 345 tasks.

## 2. How the game writes commands

Commands are two big-endian words (8 bytes), the opcode in the top byte of the first. The game appends them through a pointer kept in a graphics-context structure: it loads the pointer, writes the two words, stores the pointer plus 8. Pattern at `0x80015B80`–`0x80015B94`:

```
80015b80  lui   t9, 0x100          ; w0 = 0x01004008
80015b84  ori   t9, t9, 0x4008
80015b88  addiu t8, v0, 8          ; pointer + 8
80015b8c  sw    t8, 720(s3)        ; store the bumped pointer (offset 0x2D0)
80015b90  sw    s0, 4(v0)          ; w1
80015b94  sw    t9, 0(v0)          ; w0
```

The context has several such pointers (offsets `0x2B0`, `0x2C0`, `0x2C4`, `0x2D0` are used by different routines for the same pattern), so the game builds several lists at once; they are chained with `DE` commands (call and branch) into one tree, the root being the task's data pointer.

## 3. Commands

Counts are over the 600-frame run. "Site" is a code location that builds the word (a `lui` of the opcode followed by a `sw` to the list pointer). "Sample" is a word pair found in a real list. Names are the SDK's: the opcode, the layout and the evidence for each row come from this binary, but the label is the one the official N64 Programming Manual gives the graphics macro that emits the command (the gSP and gDP command reference of its graphics chapter; section numbers were not checked, the manual not being at hand). The correspondence is `VTX` gSPVertex, `CULLDL` gSPCullDisplayList, `TRI1` gSP1Triangle, `TRI2` gSP2Triangles, `QUAD` gSP1Quadrangle, `TEXTURE` gSPTexture, `POPMTX` gSPPopMatrix, `GEOMETRYMODE` gSPSetGeometryMode and gSPClearGeometryMode, `MTX` gSPMatrix, `MOVEWORD` and `MOVEMEM` the internal gMoveWd and gMoveMem of gSPSegment, gSPFogPosition, gSPNumLights, gSPViewport and gSPLight, `DL` gSPDisplayList and gSPBranchList, `ENDDL` gSPEndDisplayList, `SETOTHERMODE_L` and `_H` gSPSetOtherMode, `TEXRECT` gSPTextureRectangle, `RDPHALF_1` and `_2` its two extra words, the four syncs gDPLoadSync, gDPPipeSync, gDPTileSync and gDPFullSync, `SETSCISSOR` gDPSetScissor, `SETOTHERMODES` gDPSetOtherMode, `LOADTLUT` gDPLoadTLUT, `SETTILESIZE` gDPSetTileSize, `LOADBLOCK` gDPLoadBlock, `LOADTILE` gDPLoadTile, `SETTILE` gDPSetTile, `FILLRECT` gDPFillRectangle, the five colour registers gDPSetFillColor, gDPSetFogColor, gDPSetBlendColor, gDPSetPrimColor and gDPSetEnvColor, `SETCOMBINE` gDPSetCombine, `SETTIMG` gDPSetTextureImage, `SETZIMG` gDPSetDepthImage and `SETCIMG` gDPSetColorImage.

| Op | Name | Layout | Count | Site | Sample |
| --- | --- | --- | --- | --- | --- |
| `01` | VTX | `n = w0[19:12]`, `end = w0[7:1]`, first slot `end - n`; `w1` = vertex address | 22,483 | `0x80015B80` | `01003006 01001C00` |
| `03` | CULLDL | `first = w0[15:0]/2`, `last = w1[15:0]/2` (vertex slots) | 2,736 | `0x80086E70` | `03000000 0000001E` |
| `05` | TRI1 | slots × 2 in bytes `w0[23:16]`, `w0[15:8]`, `w0[7:0]` | 6,618 | – | `05000204 00000000` |
| `06` | TRI2 | as TRI1 in `w0` and again in `w1` | 82,650 | `0x80016468` | `06000204 0006080A` |
| `07` | QUAD | same encoding as TRI2; drawn as the triangles (a,b,c) and (a,c,d) | 3,648 | – | `07002026 00002624` |
| `D7` | TEXTURE | `on = w0[7:0]`, `level = w0[13:11]`, `tile = w0[10:8]`; `w1` = `scaleS<<16 \| scaleT` (0xFFFF ≈ 1) | 12,043 | `0x80016934` | `D7000002 FFFFFFFF` |
| `D8` | POPMTX | pops `w1 / 64` matrices of the model-view stack | 920 | – | `D8380002 00000040` |
| `D9` | GEOMETRYMODE | `mode = (mode & w0[23:0]) \| w1` | 21,864 | `0x80016A6C` | `D9FFFFFF 00030000` |
| `DA` | MTX | `w1` = matrix address; `w0[7:0] ^ 1` = parameter bits (below) | 10,698 | `0x8001210C` | `DA380007 80174508` |
| `DB` | MOVEWORD | `w0[23:16]` = index, `w0[15:0]` = offset; `w1` = value | 17,130 | `0x80013928` | `DB060004 802C3950` |
| `DC` | MOVEMEM | `w0[23:16]>>3 + 1` = 8-byte units to copy, `w0[15:8]*8` = destination offset, `w0[7:0]` = target; `w1` = source address | 9,255 | `0x8002294C` | `DC08000A 80174568` |
| `DE` | DL | `w0[16]` = 0 call (returns at `DF`), 1 branch (does not); `w1` = list address | 18,256 | `0x8001214C` | `DE010000 80168688` |
| `DF` | ENDDL | ends the list (returns to the caller if called) | 14,594 | `0x8001EFAC` | `DF000000 00000000` |
| `E1` | RDPHALF_1 | follows TEXRECT; `w1` = `s<<16 \| t` | 3,680 | `0x80021274` | `E1000000 00000000` |
| `E2` | SETOTHERMODE_L | `len = w0[7:0]+1`, `shift = 32 - w0[15:8] - len`; `w1` = new bits | 8,741 | `0x80016A48` | `E200001C 00000000` |
| `E3` | SETOTHERMODE_H | as `E2` on the high half | 10,457 | `0x80016900` | `E3000A01 00300000` |
| `E4` | TEXRECT | RDP rectangle, then `E1` and `F1` | 3,680 | `0x80024D38` | `E4484180 00184178` |
| `E6` `E7` `E8` `E9` | LOADSYNC, PIPESYNC, TILESYNC, FULLSYNC | no operands | 33,536 / 63,122 / 5,229 / 345 | `0x80016994` `0x800168C8` `0x8007F050` `0x800A1E64` | `E7000000 00000000` |
| `ED` | SETSCISSOR | RDP | 2,809 | `0x8007CB14` | `ED000000 005003C0` |
| `EF` | SETOTHERMODES | RDP: `w0[23:0]` = high half bits, `w1` = low half | 5,053 | `0x80024E14` | `EF382C30 00000000` |
| `F0` | LOADTLUT | RDP | 4,887 | `0x800803C8` | `F0000000 070FC000` |
| `F1` | RDPHALF_2 | follows TEXRECT; `w1` = `dsdx<<16 \| dtdy` | 3,680 | `0x80024D84` | `F1000000 04000400` |
| `F2` | SETTILESIZE | RDP | 39,989 | `0x80016A14` | `F204F050 0108B08C` |
| `F3` | LOADBLOCK | RDP | 21,008 | `0x800210EC` | `F3000000 071FF200` |
| `F4` | LOADTILE | RDP | 7,641 | `0x800CC570` | `F4000000 0700201C` |
| `F5` | SETTILE | RDP | 64,369 | `0x80016984` | `F5900000 07014452` |
| `F6` | FILLRECT | RDP | 917 | `0x80060CF4` | `F64FC3BC 00000000` |
| `F7`–`FB` | SETFILLCOLOR, SETFOGCOLOR, SETBLENDCOLOR, SETPRIMCOLOR, SETENVCOLOR | RDP | 694 / 228 / 1,035 / 10,532 / 2,962 | `0x8007CC3C` `0x8001A7E8` `0x8009F430` `0x80016C20` `0x80016AC0` | `FA000000 FFAAFFFF` |
| `FC` | SETCOMBINE | RDP | 14,694 | `0x80016A24` | `FC267E60 350CF37F` |
| `FD` | SETTIMG | RDP | 33,536 | `0x80016964` | `FD900000 010029C0` |
| `FE` `FF` | SETZIMG, SETCIMG | RDP | 1,035 / 2,070 | `0x8007CD50` `0x800196BC` | `FF10013F 803B5000` |

The code for `D8`, `05` and `07` is not built by a `lui` constant the scan could find; their layouts rest on the data (below).

Opcodes `04`, `08`–`0A`, `E0`, `E5` and the others never occur; the interpreter reports any of them as unknown rather than guessing.

### Evidence for the layouts the game's own data pins down

- **VTX / TRI.** `01003006 01001C00` loads 3 vertices (`w0[19:12]` = 3) ending at slot 3 (`w0[7:1]` = 3), so slots 0–2. The next command, `05000204`, uses bytes `00 02 04` = slots 0, 1, 2 after halving. Across the run no triangle references a slot that was not loaded (0 problems), and no load exceeds 32 slots. `06000206 00000604` at `0x80016468` is a quad built as the triangles (0,1,3) and (0,3,2); `07002026 00002624` is a fan about slot 0 in the same encoding.
- **Vertex format.** 16 bytes: `x y z` (s16), flags (u16), `s t` (s16), then 4 bytes colour or normal+alpha. In the vertex array that the first VTX above loads (segment 1, offset `0x1C00`), the first vertex `FFFB 0016 000B 0000 00BA 050F 25 55 4C FF` is position (-5, 22, 11), texture coordinates (186, 1295) in S10.5, colour `25554CFF`.
- **Segments.** `DB060004 802C3950` writes `w1` to segment 1; later `01001C00` is a segment-1 address. Segment 0 holds 0, so addresses with a `0x80` top byte read as physical. The `MOVEWORD` segment index writes at offsets 0 to 60 (segments 0�15), with values such as `0x803B5000`. An address resolves to `segment[w1[27:24]] + (w1 & 0xFFFFFF)`; segment 0 is 0, so `0x80xxxxxx` addresses read as physical.
- **MTX.** The parameter byte (`w0[7:0]`) takes the values 0, 1, 3, 5, 7 (counts 920, 228, 8,123, 688, 739). Xored with 1 they are 1, 0, 2, 4, 6, read as bit 0 = push, bit 1 = load (else multiply), bit 2 = projection (else model-view): 0 = push and multiply, 1 = multiply, 3 = load, 5 = multiply projection, 7 = load projection. The 920 pushing multiplies match the 920 `D8` pops, and no pop finds the stack empty. The matrix at `0x80174508`, loaded by a `DA380007`, has the sixteen s16 integer parts `0002 0000 0000 0000 0000 0003 0000 0000 �` followed by sixteen u16 fractions: `value = int + frac/65536`, row-major, used for row vectors.
- **Transform check.** With these matrices, vertices transformed to clip space and rasterised (a throwaway rasteriser, not committed) give a coherent room interior at tasks 300 and 340; 76% of all vertices lie within 1.5× the clip volume, the rest being off-screen or behind the camera.
- **Viewport.** `DC080008 80174548` copies 16 bytes `0280 01E0 01FF 0000 0280 01E0 01FF 0000`: scale (640, 480, 511), translation (640, 480, 511), in 10.2 fixed point, i.e. 320 × 240 pixels centred on (160, 120).
- **Lights.** `DB020000 00000018` (`NUMLIGHT` = 24 × lights, here 1) is followed by `DC08060A` and `DC08090A`: light 0 at slot offset 6, ambient at 9 (6 + 3 × lights; 12 when there are 2, as seen). Slots are 24 bytes apart (3 units of 8), the two look-at vectors at 0 and 3 (`DC08000A`, `DC08030A`), each copy is 16 bytes. A light is `r g b 0 r g b 0 dx dy dz 0` (`FFFFFF00 FFFFFF00 45454500`: white, direction (69, 69, 69)); the ambient is `64646400 64646400`. The `MOVEWORD` index bytes seen are 2 (number of lights), 4 (offsets 4, 12, 20, 28, always together: clip ratios, ignored), 6 (segments), 8 (fog: `DB080000 476DB993` = multiplier `0x476D`, offset `0xB993` as s16) and 14 (value 10, once per projection multiply, ignored).
- **Geometry mode.** `D9` `w0` low 24 bits mask what stays; `w1` is set. Typical `D9FFFFFF 00030000` (set bits 16, 17) and `D9F3FFFF 00000000` (clear bits 18, 19). The setting at the start of a lit solid pass, `D9000000 00220405`, sets `0x200000 | 0x20000 | 0x400 | 0x4 | 0x1`. Each bit is named from its use: `0x1` (always set with depth), `0x4` (shade), `0x400` and `0x200` (back-face and front-face culling: only ever set one at a time), `0x10000` (fog: set with `FOG` vertex alpha), `0x20000` (lighting: vertices are loaded with a signed normal instead of a colour), `0x40000` and `0x80000` (texture coordinate generation, set together by `D9FFFFFF 000E0400`), `0x200000` (smooth shading).
- **Other modes.** `E3000A01` shifts 20, length 2 on the high half: the RDP cycle-type field (bits 52�53 of the 64-bit word), value `0x00300000` = 3 (fill) right before an `F6` fill rectangle, as expected. The high half takes eight distinct values in the run (`0x382C30`, `0x182C10`, `0x102C30`, `0x2CF0`, `0x18AC10`, `0x82C10`, `0x802C30`, `0x182CA0`); every batch that draws a CI texture has bits 15�14 = 2, which agrees with the hardware's palette fields (bit 15 enable, bit 14 IA16 instead of RGBA16).
- **Texture filter: bilinear on every draw.** The filter field is bits 13-12 of the high half of the other modes (0 point, 2 bilinear, 3 average, from the RDP description on n64brew.dev). All eight high-half values seen in the 600-frame run (the list above) have it equal to 2: `0x382C30`, `0x182C10`, `0x102C30`, `0x2CF0`, `0x18AC10`, `0x82C10`, `0x802C30` and `0x182CA0`, each `>> 12 & 3 = 2`. So the game asks for bilinear filtering for every textured draw, and the renderers do the hardware's 3-point filter (`web/shader.ts`) for any non-zero field; the software renderer in `tools/gfx/raster.ts` samples the nearest texel.
- **Texture rectangle.** `E4484180 00184178` then `E1000000 …` and `F1000000 04000400`: `w0` = lower-right corner `xl=0x484 yl=0x180`, `w1` = tile and upper-left corner `xh=0x184 yh=0x178` (10.2 pixel units); `dsdx = dtdy = 0x400` = 1.0 (S5.10).
- **Fill rectangle.** `F64FC3BC 00000000` covers (0,0)–(319,239) in 10.2 units (`0x4FC`, `0x3BC`).
- **Scissor.** `ED000000 005003C0`: lower-right (320, 240) in 10.2 units.
- **Texture formats.** The `fmt` / `siz` pairs seen in tiles used by triangles are (fmt, siz) = (0,2) RGBA16 22,986×; (2,1) CI8 11,608×; (4,1) I8 7,364×; (4,0) I4 1,368×; (2,0) CI4 342×; (3,1) IA8 227×; (3,0) IA4 226×; (3,2) IA16 once. Decoding one of each with the formats named after the hardware numbering (RGBA 0, YUV 1, CI 2, IA 3, I 4) gives recognisable images (grass, rock, brick, a sphere map, a ring, noise), so the numbering is right. No RGBA32 and no YUV texture occurs in these frames; RGBA32 is decoded from the format description only.

## 4. What the interpreter does with them

`tools/gfx/dl.ts`, `DisplayListInterpreter.run(ram, startAddress)`:

- State starts clear for each task. Segment table, model-view stack (push/pop), projection, 32 vertex slots, 8 tile descriptors, a model of the 4 KiB TMEM, light slots, fog, viewport, scissor, colour images and registers (prim, env, fog, blend, fill), geometry mode, the two other-mode halves and the decoded combiner.
- **Vertices** are transformed by model-view � projection into clip space (x, y, z, w). Lit colours, texture generation, fog and the light vectors follow the microcode as section 9 records them, with its evidence.
- **Batches.** A triangle batch is every triangle drawn since the last change of render state; it carries a snapshot of the state (geometry mode, both other-mode halves, combiner fields per cycle, colours, texture command, tiles, viewport, scissor, fog, images) and the decoded textures of the tile named by the texture command and of the following tile. Texture rectangles and fill rectangles are one batch each.
- **Textures.** `SETTIMG` records the source; `LOADBLOCK`, `LOADTILE` and `LOADTLUT` copy bytes into a 4 KiB TMEM model at the tile's `tmem` address, in stream order (a block is contiguous; a tile uses the tile's `line` as the row stride; palette entries are 16-bit, stored from the TLUT tile's address, palette `p` of a CI4 texture at TMEM word `256 + 16p`). The decode reads rows `line × 8` bytes apart (×2 for 32-bit texels) from the tile's address, which is where a load put the texel at the tile's upper-left bound, with the tile size (`F2`) giving width and height. Scrolling is left to the renderer through the bounds in the tile state. The hardware's odd-row word swap is not modelled: the loads and the reads would cancel out.
- **CULLDL** ends the current list when every vertex of the range shares a clip flag: x or y at or beyond �w on one side, w <= 0, or z >= w (section 9).
- Triangles are dropped when their three vertices share a clip flag, and clipped to twice the screen (the guard band) when a vertex lies outside it, as the microcode does (section 9). Not modelled: face culling (the mode bits are in the state; the renderer decides), clip ratios, YUV textures, LOD, texture shifts and masks (in the tile state for the renderer).
- Anything with an opcode outside §3 is returned in `unknown` (address and both words) and execution continues; inconsistencies the interpreter worked around (a vertex slot that was never loaded, a matrix stack underflow, an address outside RAM, a lighting or movemem target not listed above) are returned in `problems`.

## 5. Assumptions that still need footage to confirm

- **Fog constants: verified in the game's code.** The routine at `0x8007E250` (arguments: list pointer in `a0`, fog colour in `a1`-`a3` and the stack, near at `sp+0x1C`, far at `sp+0x20`; it emits an `F8` then a `DB08`) builds the `DB08` word from near and far. Near >= 1000 gives 0 (`0x8007E2B8`), near >= 997 gives `0x7FFF8100` (`0x8007E2E4`), near < 0 gives 255 (`0x8007E324`), otherwise `multiplier = 128000 / (far - near)` and `offset = (128000 - 256 * near) / (far - near)`, both truncated to 16 bits (`div` at `0x8007E358` and `0x8007E378`). The sample `DB080000 476DB993` is exactly near 993, far 1000: 128000 / 7 = 18285 = `0x476D`, (128000 - 254208) / 7 = -18029 = `0xB993`. With `fog = multiplier * z + offset` and z the projected depth in -1..1 this is `256 * (d - near) / (far - near)` for `d = 500 * (z + 1)` in 0..1000, and the game's own cut-offs at 1000 and 997 are the end of that range: the formula in section 4 is the one the constants are made for. The `0x8001A844`-`0x8001AC10` sites build another `DB08` word with equal halves, `128000 / (s16(float * k) + 1500)` (`k` read from `0x80103FC0`/`0x80103FC4`); the interpreter reads its halves as multiplier and offset like any other. What stays unverified is the RSP's fixed-point rounding and whether it clamps before or after the divide; the title and logo frames were checked by eye only.
- **Lighting and texture coordinate generation: verified against the microcode** (section 9); the formulas in section 4 of earlier versions of this note (normalised normal, `ambient + sum`, texture coordinates 0..1) were wrong.
- `CULLDL`'s slot range is read as `w0[15:0]/2` to `w1[15:0]/2`: the samples (`0`, `0x1E`) cover the 16 vertices loaded just before.

## Known issue: the bridge in the title attract sequence

Reported from the browser: in the title attract sequence the shot with two figures on a bridge draws everything but the bridge. Not located yet: frames 26-4840 of the headless run were dumped every 40 frames (`--dump out/frames --dump-every 40 --dump-from N`) and none shows such a shot; the closest, around frame 3300 (a rider crossing a stream, no bridge under it), was analysed:

- The frame has no unknown command and no interpreter problem. 23 `CULLDL` lists end their list; rendering the same display list with `CULLDL` ignored changes 11 pixels out of 76,800 (face culling, not list culling), so `CULLDL` does not hide anything there.
- Batches whose vertices are all behind the camera (`w < 0`, world-space room mesh drawn with an identity model-view matrix loaded from `0x800FCD00`) are correctly not drawn.
- Still unchecked: near-plane crossing meshes (the software renderer clips against the near plane, the interpreter does not), and the actual frame. To continue, take the `frame N` value of the overlay (`#debug` on the page URL) when the shot is on screen and dump that window.
- Update: the microcode's triangles and this interpreter's cover the same pixels (0.5% at most) in the castle sequence of the intro and the title shots, near-plane and far-plane crossings included, so a missing bridge is not an interpreter culling or clipping fault; see docs/re/gaps.md for what was ruled out.

## 6. Reproducing

```
npm run port -- --rom "$OOT_ROM"            # builds dist/oot.js
npm run headless -- --frames 600 --dl       # parses every graphics task; exit code 4 on an unknown command
```

`npm run headless -- --frames 800 --dump out/frames --dump-every 50` writes the frames the video interface shows as PNGs (`tools/gfx/raster.ts`, a software renderer with the same rules as `web/shader.ts`). Frames 50-250 show the Nintendo 64 logo fading in and turning; from frame 300 the moonlit field of the title scene fades in, with the rider on the horizon by frame 600.

`tools/gfx/frames.test.ts` runs the same check as a ROM-gated test; the synthetic tests in `tools/gfx/dl.test.ts` and `decode.test.ts` need no ROM.

## 7. Alpha cutouts, near-plane depth and the shadow (frames of the new-game script)

Seen in the 19,100 frames of `tools/headless/newgame.input` (every batch listed with its other-mode words; the distinct low halves are `0x504240`-`0x504b51` for rectangles and the 2D HUD, `0xC8104xxx` for translucent and decal surfaces, `0xC8112078` for opaque surfaces and `0xC8113078` for cutouts).

Low-half bits used below (from the RDP descriptions on n64brew.dev): bit 0 alpha compare, bit 3 antialias, bit 4 depth compare, bit 5 depth update, bit 6 image read, bits 8-9 coverage destination, bits 10-11 depth mode (0 opaque, 2 translucent, 3 decal), bit 12 coverage times alpha, bit 13 alpha from coverage, bit 14 force blend; bits 16-31 the two blender cycles `(p * a + m * b) / (a + b)`.

### Cutouts: coverage times alpha

- **Evidence.** `0xC8113078` differs from the opaque `0xC8112078` by bit 12 alone (`0x1000`). It is used from frame 262 on, by thousands of batches in frames 13100-13900 alone, whose textures are RGBA16 (`f0 s2`) with both kinds of texel: 32x32 with 526 texels of alpha 0 and 498 of alpha 255 (average colour of the transparent texels `16,49,0`), 16x32 with 203/309 (average `176,168,49`), 64x64 I4 with 1115/2981. The combiner `127E03 / FFFFF3F8` takes the alpha from the texel and the colour from texel times shade, and the blender never reads the framebuffer in this mode (force blend is off), so alpha has no other use: it can only decide whether a pixel is written.
- **Formula.** With bit 12 set the coverage (eight sub-pixel samples, 8 for a pixel inside the triangle) is multiplied by the pixel alpha: `(8 * alpha + 4) >> 8`, so a pixel with alpha 31 or less (of 255) keeps no coverage and is not written. Every other pixel is written opaque (the blender does not blend without the force-blend bit). With bit 13 set and bit 12 clear (`0xC8112078`, the opaque surfaces) the blender's pixel alpha is the coverage, 1 inside the triangle, so a transparent texel does not hide anything there. `web/shader.ts` (`MIN_COVERAGE_ALPHA = 32/255`, discard in the fragment shader) and `tools/gfx/raster.ts` do this; before, the bit was ignored and the transparent texels drew solid.
- **Check.** Frame 13300 (the forest): of the batches with bit 12 and a texture holding transparent and opaque texels, drawing each alone writes fewer pixels with the bit than without (a 32x32 one: 10,950 against 12,938); `tools/headless/headless.test.ts` checks it. The unit tests in `tools/gfx/raster.test.ts` do the threshold (alpha 32 stays, 31 goes) on synthetic textures.

### The beating heart: vertices in front of the near plane

- **Evidence.** The status display of a new file draws two hearts as texture rectangles (`E4`, 16x16 IA8 at x = 24.5 and 34.5, y = 20.5, primitive colour `255,70,50`) and the third, the beating one, as two triangles with the same combiner (`309661 / 552EFF7F`) and texture: screen x 43.2-57.1, y 18.5-32.5 at frame 19050. Its four vertices have clip coordinates `z = -1.4, w = 1` (the matrices are the 2D ones the HUD uses), so `z < -w`: in front of the near plane. The hardware shows this heart (a new file shows three), so such a vertex is not clipped away (confirmed in the microcode, below); before, the renderers clipped the whole quad (OpenGL clips on `-w <= z`) and the third heart was missing.
- **Microcode evidence (graphics microcode of the task record: text at `0x800E1EC0`, data `0x801123C0`; disassembled with `tools/audio/rspdis.ts`).** Layout: the task's microcode is run from the RSP's instruction memory with its first byte at `0x1080`; the last `0x80` bytes of the 4 KiB text and two further pieces of the file (descriptors at data `0x2E0`, `0x2E8`, `0x410`, `0x418`, loaded by the DMA routine at `0x1FD8`) are brought into `0x1000`-`0x107F` and `0x12D0` as needed, so the addresses below are instruction-memory addresses (text offset + `0x1080`). The command dispatch (`0x119C`-`0x11B0`) jumps through a halfword table at data `0x36E` indexed by the opcode byte: `VTX` `0x14F0`, `TRI1` `0x17B4`, `TRI2`, `QUAD` `0x17AC`.
  - *Vertex flags.* The vertex loop (`0x1590`-`0x1730`) compares each transformed `x, y, z, w` with `w` (`vch` at `0x1640`, `vcl` at `0x1648`), reads the compare flags (`cfc2` at `0x1654`, `0x16CC`) and stores them in the vertex record at offset `0x24` (`sh` at `0x16BC`, `0x16E4`, `0x16F4`, `0x16F8`). The compare sets, per lane, a bit of the low byte for `v <= -w` and a bit of the high byte for `v >= w` (n64brew description of `VCH`); lanes 0-3 are `x, y, z, w`. The word therefore holds `x<=-w` as `0x00100000`, `y<=-w` `0x00200000`, `x>=w` `0x10000000`, `y>=w` `0x20000000`, `z<=-w` `0x40` (near), `w<=0` `0x80`, `z>=w` `0x4000` (far). A scratch interpreter of the microcode (not committed) run on vertices at `z / w` from 0.98 to 1.2 sets `0x4000` from `z / w = 1` upward and not below, as this reading predicts.
  - *Which planes are clipped.* The polygon clipper (`0x12DC`-`0x14E8`) walks six plane masks read from data `0x3F8`-`0x40C`: `0x00100000, 0x00200000, 0x10000000, 0x20000000, 0x00004000, 0x00000080`: x and y on both sides, the far plane and `w`. `z<=-w` (`0x40`) is not among them. The triangle code (`0x1820`-`0x1878`) drops a triangle whose three flag words share a bit of `0x70B0` (`x`, `y`, `w`, far; again no `0x40`) and sends it to the clipper only when a flag in the mask at data `0x3CC` is set; that word is `0x30304080`, the union of the six masks, and the only store to it is the restore at `0x14E8` of the value read at `0x12FC`.
  - *Depth.* The vertex loop clamps the viewport-scaled `z` at zero (`vge` against zero at `0x15E0`), stored in the record by `ssv`.
  - *Clip ratio and geometry mode.* The plane coefficients are in data `0x180`-`0x1B0` (the x and y planes carry the factor 2); no instruction of the microcode stores to that range, so the `MOVEWORD` clip-ratio writes (index 4) change nothing there, and no instruction stores to `0x3CC` apart from the restore above, so the geometry mode cannot change the plane set. The geometry word is at data `0x1EC`; the vertex code reads its bit 16 (fog) and bit 17 (lighting) at `0x1508`-`0x1520`.
  - So a vertex in front of the near plane (`z < -w`, `w > 0`) is neither clipped nor rejected: the triangle is drawn with that vertex's depth clamped to the nearest value, `x` and `y` unchanged.
- **Formula.** For a vertex with `w > 0` and `z < -w`, `z` is taken as `-w` (screen depth zero, the clamp above); `x`, `y`, `w` stay. The vertex shader does it (`web/shader.ts`) and the software renderer likewise. Vertices with `w <= 0` stay clipped (the `w` plane), and beyond the far plane the triangle is clipped as before. The heart's vertices at `z / w = -1.4` take this path, which is why the hardware shows the third heart.
- **Check.** At frame 19050 the three hearts each cover 30, 37 and 54 pixels of the heart colour; the headless test checks that three hearts are there, and `tools/gfx/raster.test.ts` draws a flat quad at `z = -1.4` and checks it fills the screen.

### The shadow under Link and the ground brightening

- **What it is.** The two draws under Link at frame 19050 have `H = 0x182C10` (two cycles), `L = 0xC8104F50`: depth compare without update, depth mode 3 (decal), force blend, image read. Blender cycle 0 `(fog colour * shade alpha + pixel * (1 - shade alpha))`, cycle 1 `(pixel * pixel alpha + framebuffer * (1 - pixel alpha))`; combiner `1197FF / FFFFFE38`: colour texel times primitive colour (`0,0,0`), alpha texel alpha times primitive alpha (246, 247); the texture is 32x64 IA16. The geometry mode has the fog bit, so the shade alpha is the fog factor, 0 there.
- **Result.** The pixel is black blended over the framebuffer by about 0.96, so the ground only darkens: at frame 19050, 131 pixels are darker with the decals than without and none is lighter (headless test), in the browser renderer too (a screenshot of the house at frame 17309 shows the dark shadow under Link). With a fog factor above 0 the shadow colour moves towards the fog colour first, as the fogged ground does.
- **Brightening not reproduced as a shadow effect.** No draw in the new-game run lightens the pixels under Link. What does lighten ground-level surfaces is the cutout bug above: the transparent texels of the forest's grass and leaf textures are often light (average `176,168,49` and `165,164,159` for 16x32 and 32x64 textures of this kind) and were drawn as opaque squares. That is the likeliest source of the reported brightening, not confirmed in the browser in the playable forest (the exit of Link's house cannot be reached with the renderer as it is).

### Floor brightening: what was checked after the report that it covers a large area

- Link's house (frames 19000-19400, Link walking): the floor pixels sampled at six screen points stay `0,70,0` in every frame, so nothing there changes the floor's colour; the room drew without its background picture (section 8) and without lit floor geometry.
- Lights of the lit draws from frame 13000 on (forest): always two directional records (`46465A`/`FFFFFF`, directions `00 88 EC` and `00 78 14`, i.e. (0,-120,-20) and (0,120,20)) and an ambient `505050`; no light carries a position or an attenuation, and the pad byte of each light varies from draw to draw without effect on the directions. No Navi light appears as an extra light record. The sum `ambient + light * max(0, n.d)` is clamped at 1 by the interpreter, which is unverified against hardware (section 5).
- Not found: a draw that lightens the floor in the frames reachable headless. The playable forest, where it was reported, cannot be reached.

### Fog of vertices behind the eye

- **Symptom (browser, forest).** The foreground floor turns pale yellow, the fog colour (`200,200,150`), over most of the screen when Link has walked a few steps, and is dark green-brown a few steps earlier.
- **Cause found in the draws.** At frame 13700 of the new-game script, 534 of 2,181 triangles have a vertex with `w <= 0.5`; vertices behind the eye have `w < 0` and a clip `z` of the opposite sign, so `z / w` is slightly above 1 (1.02 to 3.0) and the interpreter's per-vertex fog, `clamp(z / w * multiplier + offset, 0, 255) / 255` with the game's `multiplier = 32000`, `offset = -31744`, comes out at 1.0 for every one of them. A floor triangle with such a vertex gets fog interpolated from 0 (front vertices) to 1 (that vertex): the part in front of the eye is tinted by the clip distance and changes as the vertex crosses the plane while Link walks.
- **Microcode.** The per-vertex fog is the low byte of `max(v, 0x7F00)` for a saturated 16-bit depth value `v` (`vge` against `0x7F00` at `0x15D8`, stored into the vertex's alpha byte by `sbv` at `0x15F4`/`0x15FC` and the loop's tail at `0x1758`/`0x1760` when the geometry word has the fog bit), i.e. a clamp to 0..255 of a value linear in the depth, as the interpreter computes. What the microcode stores for a vertex with `w <= 0`, and what the clipper's new vertices at the `w` plane get, was not established: the scratch interpreter reproduced screen x within one unit but not the fog byte, so it was not used as evidence.
- **Formula used (superseded).** Per-pixel fog from z / w was a workaround; the microcode computes the fog factor per vertex and a vertex behind the eye gets none (section 9), which the interpreter now does.

## 8. Background pictures: the 2D microcode (`DD`, `E1`, `09`, `0A`)

Link's house (scene 52) is a pre-rendered room: its picture is the JPEG that the RSP task of `runtime/jpeg.c` decodes (`docs/re/newgame.md`), and the display list draws it with commands the 3D microcode does not have. Before, the interpreter returned three unknown commands (`DD`, `0A`, `DD`) and two stray `E1` half-words per frame there.

- **The list.** At frame 19002 (list around `0x8017AC00`), after the room's own list (`DE000000 030023A8`):

  ```
  E1000000 001127E0   data pointer of a microcode
  DD0007FF 000E3250   microcode text; the game's builder converts both with 0x800AD11C / 0x800AD10C
  DE010000 8017AC38   branch over the record that follows
  <40 bytes>          the picture record
  E7000000 00000000   pipe sync
  EF200000 00000001   set other modes: cycle type bits 21:20 = 2, copy
  0A000000 8017AC10   the picture command; w1 = address of the record
  E7000000 00000000
  E1000000 801123C0   data of the 3D microcode (the task record's data, section 1)
  DD0007FF 800E1EC0   text of the 3D microcode (the task record's text)
  ```

  The builder is `0x80080264` (list pointer in `a0`, picture address in `a1`, size and frame arguments after); the E1/DD pairs are written at `0x80080730`-`0x80080770` and `0x8008082C`-`0x80080868`. `E1` carries the data pointer and `DD` the text pointer of the microcode to run for the commands that follow; the game switches to the 2D one for the picture and back after it.
- **The microcode is S2DEX.** The data at `0x801127E0` holds `RSP Gfx[Safe] S2DEX fifo 2.05` at offset `0x138`; the interpreter takes `DD` as "2D microcode loaded" when the data announced by the last `E1` contains `S2DEX` in its first 1 KiB. Its text (`0x800E3250`, 4 KiB, IMEM `0x1080`; disassembled with `tools/audio/rspdis.ts`) dispatches like the 3D one (`0x11B4`-`0x11C8`: `lhu` of the halfword at data `0x370 + 2 * opcode`, then `jr`). Table entries: opcode `09` goes to `0x1B84`, `0A` to `0x1208`, `0B` to `0x10E8`. `0A`'s handler (`0x1208`) starts two DMAs and reads the record into data `0x3B0`-`0x3D7` (`addi $s3, $zero, 0x27` = 40 bytes at `0x1210`), and emits texture rectangles (`lui $t4, 0xE400` at `0x1384`) and tile settings (`0x35...` words at `0x1288`, `0x12C0`).
- **Which opcode is which mode.** The builder uses `0A` after `EF` with cycle type 2 (copy) and no combiner write (`0x80080468`-`0x80080488`), and `09` after `EF ..CF0`, a combiner (`FCFFFFFF FFFCFC7E`) and `0B 0000000C` (`0x800804A0`-`0x80080530`), i.e. one-cycle mode with scaling fields (`0x400` written at record offsets 28 and 30). Only the copy form runs in the 19,060 frames checked (840 `0A`, no `09`); the one-cycle reading is from the builder only, and which of offsets 28 and 30 scales which axis is not observed (both are written with the same value).
- **The record (40 bytes).** Offsets written by the builder, with the values of Link's house (dump at `0x8017AC10`, `0000 0500 0000 0500 0000 03C0 0000 03C0 0300 2480 FFF4 0002 ...`):

  | Offset | Size | Field | House | Evidence |
  | --- | --- | --- | --- | --- |
  | 0 | u16 | image x, 10.5 | 0 | `sh $zero, 0($a0)` `0x800802E4` |
  | 2 | u16 | image width, 10.2 | `0x500` = 320 px | `width << 2`, `0x800802F4`-`0x800802F8` |
  | 4 | s16 | frame x, 10.2 | 0 | float argument x 4, `0x80080318`-`0x80080324` |
  | 6 | u16 | frame width, 10.2 | `0x500` | same value as offset 2, `0x80080430` |
  | 8 | u16 | image y, 10.5 | 0 | `sh $zero, 8($a0)` `0x80080300` |
  | 10 | u16 | image height, 10.2 | `0x3C0` = 240 px | `height << 2`, `0x80080330`-`0x80080334` |
  | 12 | s16 | frame y, 10.2 | 0 | float argument x 4, `0x80080344`-`0x80080360` |
  | 14 | u16 | frame height, 10.2 | `0x3C0` | same value as offset 10, `0x80080434` |
  | 16 | u32 | picture address (segmented) | `0x03002480` | argument `a1`, `0x8008033C` |
  | 20 | u16 | load mode | `0xFFF4` | constant, `0x80080340`; the microcode tests the sign of the byte at 21 (`lb`, `0x139C`-`0x13A8`) |
  | 22 | u8 | texel format | 0 (RGBA) | argument, `0x80080348`; microcode `lbu` of data `0x3C6` (`0x12A8`) |
  | 23 | u8 | texel size | 2 (16-bit) | argument, `0x80080364`; microcode `lbu` of data `0x3C7` (`0x12AC`) |
  | 24, 26 | u16 | palette, flip | 0 | `0x80080368`, `0x8008036C` |
  | 28, 30 | u16 | scales, 5.10 | `0x400` in the one-cycle form only | `0x800804AC`-`0x800804B0` |

  Bytes after offset 27 are not written in the copy form (the dump shows leftovers there: `0x0053`, `0x0018`), so the interpreter reads the scales only for opcode `09`. The picture at `0x03002480` is segment 3 (set by `DB06000C 80218950`, the room file) plus `0x2480` = `0x8021ADD0`; its first 32 bytes equal those at the decoded image `0x80129E80`, 320 x 240 RGBA16 with rows 640 bytes apart.
- **Meaning (what the interpreter does).** The command draws the picture's window into the frame rectangle: one texture rectangle over `frame x, y, w, h` (10.2 units; a copy-mode rectangle includes its last pixel, so the corner is `frame + size - 4`), with the texture the whole `image width / 4 x image height / 4` picture decoded from the record's address and its start at image x, y. A copy-mode rectangle steps one texel per pixel (`dsdx = 4096` in the four-pixels-per-step convention of `TEXRECT`, `dtdy = 1024`); the one-cycle form steps `1024 / scale` (5.10). The cycle type, combiner, scissor and colour image are those the game set before the command. The strips the microcode splits the draw into (a band loaded into TMEM, then a rectangle) are not modelled: TMEM holds 4 KiB and the picture is 150 KiB, but the result on screen is the same window.
- **Depth.** A copy-mode rectangle neither reads nor writes depth (the renderers' rule for rectangles). The picture comes after the room's list and before the actors, so it covers what was drawn before it, and Link, the objects and the HUD, drawn after, are in front. At frame 19000, 95% of the 76,800 pixels equal the decoded picture and the rest is Link, the furniture in front and the HUD; the headless test checks that share and that no unknown command or problem occurs in the house frames.
- **Not covered.** `0B` (written only in the one-cycle form) is still an unknown command; no frame of the new-game run contains it. The other commands of the 2D microcode (object rectangles and sprites) never occur in the 19,060 frames of the script.

## 9. What the graphics microcode computes, checked by running it

`tools/gfx/ucode-ref.ts` executes the task's own microcode (boot microcode, then the text and data the task names; the RSP instruction set as documented at n64brew.dev, including the reciprocal and reciprocal-square-root tables of its divide unit) on a task's display list and returns the RDP commands it emits and its working memory. It is used by tests only; nothing in the game runs it. `tools/gfx/ucode-compare.ts` compares a task's vertices (the records the microcode keeps at data-memory offset `0x420`, `0x28` bytes each: x y z w integer parts at +0, fractions at +8, colour and fog byte at +0x10, s and t at +0x14, screen x y and z at +0x18/+0x1A/+0x1C, clip flags at +0x24) and the pixels its triangles cover with what `dl.ts` produces. Every formula below was fitted or confirmed on synthetic lists (one vertex, controlled matrix and lights) run through it, then checked on real tasks. Results on real tasks: title and attract demo (frames 260-7400), the forest and the six houses entered from it (section 10): colour channels within 2/255 of the microcode (the fog byte within 5), texture coordinates equal to one unit of S10.5, clip coordinates within 1 (of values up to 10^3), and the covered pixels differ by 0.5% at most (most of that is fan structure of clipped polygons beyond the screen).

- **Lit colour.** Per light: `d = min(32767, max(0, 2 * dot(n, L)))` with `n` the normal's three signed bytes taken as they are (a normal shorter than 127 gives less light; it is not normalised) and `L` the light's vector in model space (below), colour += `floor(light colour * d / 32768)`; the sum starts at the ambient colour and is capped at 255. Alpha is kept. Evidence: single-light runs with normals of length 64 and 127 give 119 and 216 for ambient 20, colour 200 (the formula: 119, 216); random normals, matrices and up to three lights: mean difference 0.25, worst 2 of 255.
- **Light vector.** The microcode multiplies the slot's three direction bytes by the model-view matrix's 3x3 part into a 24.8 fixed-point vector `V = floor(256 * M L)`, sums `S = sum floor(V_i^2 / 65536)`, takes `R` = the divide unit's reciprocal square root of `S` (about 2^31 / sqrt(S); 0x7FFFFFFF for 0) and stores `L'_i = clamp(floor(V_i * R / 2^32), -128, 127)`. For `S` below 2 that keeps the vector at its length (`R` = 1: `L' = 128 M L`), above it the vector is cut to about unit length (127). The game's actor matrices scale by 0.01, which makes `|M L|` about 1.2: such a light is 1.2 times as strong as a unit one and a scale far below 0.01 dims it. Scene matrices (large scale) give a unit vector. Evidence: 120 random matrices of scales 0.0015 to 0.6 and random directions reproduce the stored bytes within 2; the forest's lights (directions (-7,119,-5), (0,-120,-20), (0,120,20)) under an actor matrix give `|M L|` 1.1-1.6, the title and the scene frames above >10. The table: 512 entries of 16 bits, entry i = floor(b / 2) with b the largest integer below 2^22 / sqrt(a), a = (i + 512) >> (i & 1) (n64brew.dev, RSP).
- **Texture coordinates.** `s = floor(s_in * scale / 65536)` in 10.5 fixed point with the TEXTURE command's scale (exact: runs with scales 0xFFFF, 0x8000, 0x1000, 1, 0). With the generation bit (0x40000) `s = 0x3FFF + n . L'` for the first look-at vector (slot 0) and the same for `t` with slot 1, then scaled as above; with the linear bit (0x80000) too, `s = 0x4000 + 8672 x + 7226 x^3`, `x = n . L' / 16129` (least-squares cubic through all 255 sampled normals along an axis, largest difference 2.3 of 32768; the microcode uses its own polynomial, which this approximates).
- **Fog.** The vertex's alpha byte becomes the fog factor `clamp(z / w * multiplier + offset, 0, 255)` (ortho and perspective runs agree within 1 of 255 for `w > 0`; the fixed-point depth and reciprocal in the microcode add up to 5 of 255 on the game's multipliers of about 18000). A vertex with `w <= 0` stores the lowest depth (screen position (32767, -32768), depth 0), so its factor is `clamp(offset)` for a zero multiplier, 0 for a positive and 255 for a negative one. This replaces the per-pixel fog of an earlier version: the fog colour no longer tints ground in front of the eye through a vertex behind it, because the clipper's new vertices fade between the real vertices' factors (run: a triangle with factors 83, 83 and a vertex behind the eye gives clipped vertices at 29, as 83 times one minus the clip parameter 0.65).
- **Clip flags and CULLDL.** Per vertex a flag for x <= -w, x >= w, y <= -w, y >= w (the vector unit's clip compare: if the signs of the value and of w differ, `value + w <= 0` and `w < 0`, else `w < 0` and `value - w >= 0`), w <= 0 and z >= w (beyond the far plane). CULLDL ends the list when the flags of the range share a bit (confirmed on a dozen vertex placements; the far plane was missing before, and z <= -w, in front of the near plane, is no flag: such a list is drawn). A triangle is dropped under the same rule.
- **Clipping.** A triangle with a vertex outside twice the screen (x or y beyond `2w`), behind the eye (w <= 0) or beyond the far plane (z > w) is clipped to those planes; each new vertex interpolates every field of the edge linearly in clip space; the polygon is drawn as a fan, with the polygon walk starting at the triangle's third vertex (the start that matches 505 of the 518 triangles of a castle frame; the others match 496-503), which fixes the first vertex of the fan. In front of the near plane (z < -w, w > 0) nothing is clipped: the depth is clamped (section 7). The renderers draw into a viewport twice the screen so that this guard band is their clip volume; the shade (colour and fog factor) is interpolated linearly in screen space and the texture coordinates with perspective correction, as the RDP does.
- **Face culling.** With w > 0 and the screen's y down, a triangle whose vertices run counter-clockwise on a y-up screen is a front face; cull-back (0x400) removes the clockwise ones, cull-front (0x200) the others, both everything (confirmed on all four mode combinations).
- **BRANCH_Z (`04`).** Jumps (no return) to the address of the preceding RDPHALF_1 when the integer part of the clip-space w of the vertex in slot `(w0 & 0xFFF) / 2` is below `w1` (handler at 0xC5C of the text: `lhu t9,896(t9); lh t9,6(t9); sub v0,t9,t8; bgez`). The game uses it to switch between detail levels by distance (232 entrances of the sweep).
- **MODIFYVTX (`02`).** `w0[23:16]` 0x10 sets the colour from `w1` (rgba), 0x14 the texture coordinates (s high half, t low, S10.5, not scaled), 0x18 the screen position (10.2) and 0x1C the depth (high half) of slot `w0[15:0] / 2`.
- **Texture filter.** Bilinear (three-point) for every textured triangle and texture rectangle except in copy mode, which takes the texel under the pixel.
- **Decal depth.** The decal mode (bits 10-11 = 3) passes where the depth is within the triangle's own slope of the stored depth; the renderers move the decal's depth towards the eye by that slope (and a minimum) before comparing. Without it coplanar surfaces z-fought in the software renderer (a checker pattern on the platform's leaves at the top of the forest frame 2400 frames after the entrance).
- **Not verified, with the reason.** Positional lights (the light record's pad bytes vary; no frame of the forest or the interiors sets the bit that would use them, but the microcode has not been run with it). The exact table index of the clip ratio words (MOVEWORD index 4, not written by any frame checked). RDP-side formulas (combiner, blender, dither) are hardware: their selector tables come from the RDP descriptions on n64brew.dev; the game's use of them is covered by the combiner words the forest and houses draw with, `127E03/FFFFFDF8` (texel times shade, opaque), `127E03/FFFFF3F8` (cutout), `127EA0` and `127E60` (texel times primitive or environment colour), `121603/FF5BFFF8` (translucent decal) and `1197FF/FFFFFE38` (shadow), all of which the interpreter decodes and both renderers evaluate identically (63 of 76,800 pixels differ between WebGL and the software renderer on a forest frame, the rest being the text of the B button).

## 10. Kokiri Forest and its interiors

Scene 85 is the forest. Its exit list (scene command 0x13, entrance indices) leads to 238 (itself, spawn 0 of scene 85, reached by the ladder of Link's house), 626 (scene 52, Link's house), 193 (scene 45), 201 (scene 38), 156 (scene 39), 1075 (scene 40), 1079 (scene 41), 0 (scene 0) and 286 and 1504 (scene 91). The tests enter 238 and the first six scenes' entrances after the scripted new game (the same forcing as the scene sweep, `requestEntrance`).

- **The ladder drawn black (browser).** Cause: `Renderer.upload` bound a new texture on the active texture unit, which was unit 0 whenever the draw's second tile had a texture the cache had not seen: both units then held the second tile's picture. On the forest frame at 2400 frames after the entrance (Link on the platform) this made the ladder (tile 0: the wood, tile 1: leaves) black with a leafy outline and the minimap garbled; with the fix the software renderer and WebGL differ in 63 of 76,800 pixels, without it in 21,711. The same bug explains the path that "appears and disappears with where Link stands" (a decal whose tile 0 comes out as the other tile's picture whenever tile 1's texture is not cached, which depends on what was drawn in the last frames). Fixed: uploads bind on unit 2; `web/renderer.test.ts` checks the units with a recording context. The texture cache is also emptied between tasks only, since emptying it while a draw holds two textures deleted the first.
- **The path decal's depth.** Decals now pass within the triangle's slope; see section 9. The software renderer had no decal rule at all and z-fought on the platform's leaves (a checker pattern at the top of the frame at 2400); the browser's polygon offset was already near the same rule.
- **Not solved here (moved to the playable-forest task, details in docs/re/gaps.md).** The blink of the background, the missing bridge of the Sheik/Link shot.
