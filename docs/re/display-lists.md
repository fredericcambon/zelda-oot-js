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
- **Vertices** are transformed by model-view × projection into clip space (x, y, z, w), without perspective divide or viewport mapping. With the lighting bit, the normal is rotated by the model-view matrix, normalised, and `colour = clamp(ambient + Σ light × max(0, n · dir))`, alpha kept. Fog (bit 16): `clamp(z/w × multiplier + offset, 0, 255) / 255`. Texture coordinates are `s/32 × scaleS/65536` texels; with texture generation they are `dot(n, lookat) × 0.5 + 0.5` (0..1).
- **Batches.** A triangle batch is every triangle drawn since the last change of render state; it carries a snapshot of the state (geometry mode, both other-mode halves, combiner fields per cycle, colours, texture command, tiles, viewport, scissor, fog, images) and the decoded textures of the tile named by the texture command and of the following tile. Texture rectangles and fill rectangles are one batch each.
- **Textures.** `SETTIMG` records the source; `LOADBLOCK`, `LOADTILE` and `LOADTLUT` copy bytes into a 4 KiB TMEM model at the tile's `tmem` address, in stream order (a block is contiguous; a tile uses the tile's `line` as the row stride; palette entries are 16-bit, stored from the TLUT tile's address, palette `p` of a CI4 texture at TMEM word `256 + 16p`). The decode reads rows `line × 8` bytes apart (×2 for 32-bit texels) from the tile's address, which is where a load put the texel at the tile's upper-left bound, with the tile size (`F2`) giving width and height. Scrolling is left to the renderer through the bounds in the tile state. The hardware's odd-row word swap is not modelled: the loads and the reads would cancel out.
- **CULLDL** ends the current list when all vertices in the range fall outside the same left/right/top/bottom side of the clip volume. The near/far planes are not tested, so it never culls a list that a real RSP would draw.
- Not modelled: face culling (the mode bits are in the state; the renderer decides), clipping, perspective normalisation, clip ratios, YUV textures, LOD, texture shifts and masks (in the tile state for the renderer).
- Anything with an opcode outside §3 is returned in `unknown` (address and both words) and execution continues; inconsistencies the interpreter worked around (a vertex slot that was never loaded, a matrix stack underflow, an address outside RAM, a lighting or movemem target not listed above) are returned in `problems`.

## 5. Assumptions that still need footage to confirm

- **Fog constants: verified in the game's code.** The routine at `0x8007E250` (arguments: list pointer in `a0`, fog colour in `a1`-`a3` and the stack, near at `sp+0x1C`, far at `sp+0x20`; it emits an `F8` then a `DB08`) builds the `DB08` word from near and far. Near >= 1000 gives 0 (`0x8007E2B8`), near >= 997 gives `0x7FFF8100` (`0x8007E2E4`), near < 0 gives 255 (`0x8007E324`), otherwise `multiplier = 128000 / (far - near)` and `offset = (128000 - 256 * near) / (far - near)`, both truncated to 16 bits (`div` at `0x8007E358` and `0x8007E378`). The sample `DB080000 476DB993` is exactly near 993, far 1000: 128000 / 7 = 18285 = `0x476D`, (128000 - 254208) / 7 = -18029 = `0xB993`. With `fog = multiplier * z + offset` and z the projected depth in -1..1 this is `256 * (d - near) / (far - near)` for `d = 500 * (z + 1)` in 0..1000, and the game's own cut-offs at 1000 and 997 are the end of that range: the formula in section 4 is the one the constants are made for. The `0x8001A844`-`0x8001AC10` sites build another `DB08` word with equal halves, `128000 / (s16(float * k) + 1500)` (`k` read from `0x80103FC0`/`0x80103FC4`); the interpreter reads its halves as multiplier and offset like any other. What stays unverified is the RSP's fixed-point rounding and whether it clamps before or after the divide; the title and logo frames were checked by eye only.
- **Lighting: data verified, arithmetic not.** Verified from the game's data: the light records (colour twice, then a signed direction byte triple), the ambient record after the lights, the count word (`NUMLIGHT` = 24 x lights plus the look-at pair), the vertex's normal-instead-of-colour layout when bit `0x20000` is set. Unverified, because it is done by microcode that is never run and its source is off limits: whether the RSP normalises the direction bytes (the sample `45 45 45` has length 0.94 of 127, so the effect is below 6%), whether it clamps the dot product at 0, and the scale of the ambient term. The renderer uses `clamp(ambient + sum(light * max(0, n . d)))` with `d = byte / 127`.
- **Texture coordinate generation: not verified.** The game sets bits `0x40000` and `0x80000` (`D9FFFFFF 000E0400`) and passes two look-at vectors (`DC08000A`, `DC08030A`); the interpreter uses `dot(n, lookat) * 0.5 + 0.5` in 0..1, scaled as a normal coordinate is. Nothing in the binary's game code fixes the formula; it is a placeholder until a sphere-mapped surface is compared with footage.
- `CULLDL`'s slot range is read as `w0[15:0]/2` to `w1[15:0]/2`: the samples (`0`, `0x1E`) cover the 16 vertices loaded just before.

## Known issue: the bridge in the title attract sequence

Reported from the browser: in the title attract sequence the shot with two figures on a bridge draws everything but the bridge. Not located yet: frames 26-4840 of the headless run were dumped every 40 frames (`--dump out/frames --dump-every 40 --dump-from N`) and none shows such a shot; the closest, around frame 3300 (a rider crossing a stream, no bridge under it), was analysed:

- The frame has no unknown command and no interpreter problem. 23 `CULLDL` lists end their list; rendering the same display list with `CULLDL` ignored changes 11 pixels out of 76,800 (face culling, not list culling), so `CULLDL` does not hide anything there.
- Batches whose vertices are all behind the camera (`w < 0`, world-space room mesh drawn with an identity model-view matrix loaded from `0x800FCD00`) are correctly not drawn.
- Still unchecked: near-plane crossing meshes (the software renderer clips against the near plane, the interpreter does not), and the actual frame. To continue, take the `frame N` value of the overlay (`#debug` on the page URL) when the shot is on screen and dump that window.

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

- **Evidence.** The status display of a new file draws two hearts as texture rectangles (`E4`, 16x16 IA8 at x = 24.5 and 34.5, y = 20.5, primitive colour `255,70,50`) and the third, the beating one, as two triangles with the same combiner (`309661 / 552EFF7F`) and texture: screen x 43.2-57.1, y 18.5-32.5 at frame 19050. Its four vertices have clip coordinates `z = -1.4, w = 1` (the matrices are the 2D ones the HUD uses), so `z < -w`: in front of the near plane. The hardware shows this heart (a new file shows three), so such a vertex is not clipped away; before, the renderers clipped the whole quad (OpenGL clips on `-w <= z`) and the third heart was missing.
- **Formula.** For a vertex with `w > 0` and `z < -w`, `z` is taken as `-w` (the nearest depth); `x`, `y`, `w` stay. The vertex shader does it (`web/shader.ts`), the software renderer likewise; vertices with `w <= 0` (behind the eye) are still clipped. Depth beyond the far plane is left as it was.
- **Check.** At frame 19050 the three hearts each cover 30, 37 and 54 pixels of the heart colour; the headless test checks that three hearts are there, and `tools/gfx/raster.test.ts` draws a flat quad at `z = -1.4` and checks it fills the screen.

### The shadow under Link and the ground brightening

- **What it is.** The two draws under Link at frame 19050 have `H = 0x182C10` (two cycles), `L = 0xC8104F50`: depth compare without update, depth mode 3 (decal), force blend, image read. Blender cycle 0 `(fog colour * shade alpha + pixel * (1 - shade alpha))`, cycle 1 `(pixel * pixel alpha + framebuffer * (1 - pixel alpha))`; combiner `1197FF / FFFFFE38`: colour texel times primitive colour (`0,0,0`), alpha texel alpha times primitive alpha (246, 247); the texture is 32x64 IA16. The geometry mode has the fog bit, so the shade alpha is the fog factor, 0 there.
- **Result.** The pixel is black blended over the framebuffer by about 0.96, so the ground only darkens: at frame 19050, 131 pixels are darker with the decals than without and none is lighter (headless test), in the browser renderer too (a screenshot of the house at frame 17309 shows the dark shadow under Link). With a fog factor above 0 the shadow colour moves towards the fog colour first, as the fogged ground does.
- **Brightening not reproduced as a shadow effect.** No draw in the new-game run lightens the pixels under Link. What does lighten ground-level surfaces is the cutout bug above: the transparent texels of the forest's grass and leaf textures are often light (average `176,168,49` and `165,164,159` for 16x32 and 32x64 textures of this kind) and were drawn as opaque squares. That is the likeliest source of the reported brightening, not confirmed in the browser in the playable forest (the exit of Link's house cannot be reached with the renderer as it is).

### Floor brightening: what was checked after the report that it covers a large area

- Link's house (frames 19000-19400, Link walking): the floor pixels sampled at six screen points stay `0,70,0` in every frame, so nothing there changes the floor's colour; the room draws without the background and without lit floor geometry.
- Lights of the lit draws from frame 13000 on (forest): always two directional records (`46465A`/`FFFFFF`, directions `00 88 EC` and `00 78 14`, i.e. (0,-120,-20) and (0,120,20)) and an ambient `505050`; no light carries a position or an attenuation, and the pad byte of each light varies from draw to draw without effect on the directions. No Navi light appears as an extra light record. The sum `ambient + light * max(0, n.d)` is clamped at 1 by the interpreter, which is unverified against hardware (section 5).
- Not found: a draw that lightens the floor in the frames reachable headless. The playable forest, where it was reported, cannot be reached.
