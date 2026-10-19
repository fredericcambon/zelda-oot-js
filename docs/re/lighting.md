# Lighting: how it works today and what per-pixel lighting would take (PAL 1.0)

Research note, no rendering change. Everything about the game's data below was measured with `tools/gfx/lighting-probe.ts` on the built game (`dist/`, new-game script to frame 19000, then each scene's first entrance forced as the sweep does, 240 video frames, the last 20 graphics tasks analysed): 100 scenes, 1,982 tasks, 3,721,093 triangles, 5,780,670 vertices. Raw output: `out/lighting/lighting.json` (git-ignored). Command words quoted are from the captured lists; microcode names and macro names follow the SDK manual as in `display-lists.md`. Nothing here comes from a decompilation or an emulator.

Probe method and limits: it walks the lists in guest memory itself (calls, branches, segments, geometry mode, light slots, model-view stack, combiner, cycle type) and never culls (CULLDL and BRANCH_Z are ignored), so it sees 432,194 VTX commands where the interpreter executed 409,113 (5.6% more). Shares below are shares of what the lists contain, not of what reaches the screen. One entrance per scene, one moment per scene, child age: scenes whose lighting changes with time of day or story are seen at one point only.

## 1. Lighting today

Lighting is computed per vertex, in the interpreter inside the wasm module, not in `web/`:

- `runtime/gfx/dl.c:31` geometry-mode bits: lighting `0x20000`, texture generation `0x40000`, linear `0x80000`, fog `0x10000`.
- `dl.c:1174-1190` MOVEWORD: index 2 (`MW_NUMLIGHT`, line 1178) stores `min(7, w1 / 24)` lights.
- `dl.c:1192-1210` MOVEMEM with target `0x0a` (`MM_LIGHT`) copies 16 bytes into `light_slots[offset / 24]` (`dl.c:148`). Slots: 0 and 1 are the look-at vectors, then the lights, then the ambient (`dl.c:147`).
- `dl.c:755-832` `load_vertices`: with the lighting bit (line 776) the vertex's last four bytes are read as a signed normal and alpha (line 799) instead of colour; `light()` (`dl.c:516`) produces the colour; the fog bit replaces alpha with the fog factor (line 811). The light vectors are computed once per load by `model_direction()` (`dl.c:498`) from the model-view matrix.
- `dl.c:960-961` `emit` writes position, colour (rgba as floats) and uv to the result arrays. The renderer's vertex format is 10 floats (`web/renderer.ts:82, 150-156`; `web/shader.ts:362-365`): no normal reaches the GPU, and the shader receives a finished shade colour.

The formulas are in `display-lists.md` section 9 (verified against the game's own microcode): `colour = ambient + sum_lights floor(light colour * max(0, 2 n.L') / 32768)`, capped at 255, with `n` the raw normal bytes (not normalised) and `L'` the light direction transformed by the model-view matrix and cut to about unit length.

Commands seen in this game's lists (capture of the Kokiri Forest task, entrance 238, frame 240 after the entrance):

```
0x8017ac38: dc08000a 80186738        look-at vector 1, slot 0 (offset 0)
0x8017ac40: dc08030a 80186748        look-at vector 2, slot 1 (offset 3 * 8)
...
0x800f6180: d9000000 00230405        geometry mode := 0x230405 (lighting 0x20000, fog 0x10000, smooth 0x200000, cull back 0x400, 0x4, 0x1)
0x8024dc38: d9fcffff 00000000        clear 0x30000: lighting and fog off
0x8024dc40: 01008010 0300ae10        VTX, unlit room vertices (segment 3)
0x8024dc58: d9ffffff 00030000        set 0x30000: lighting and fog on
0x8024dcb0: fc127e03 fffffdf8        combiner: texel * shade
0x8024dcd8: 0101602c 0300ab10        VTX, 22 lit vertices
```

and at the draw of the lights: `dc08060a 80174408` (light 0 → slot offset 6 · 8 = 48 = slot 2), `dc08090a 80174418` (light 1 → slot 3), `dc080c0a 80174400` (ambient → slot 4 = 2 + 2 lights), after `db020000 00000030` (two lights = 24 · 2) in the lists that set them. Over all 100 scenes the lit loads had 2 lights (253,088 loads), 3 (26,792) or 4 (3,992); never 1 or 5+. The geometry modes at vertex loads are always one of `0x20xxxx`-`0x23xxxx` with bit 17 set when lit, plus `0x2e`/`0x2f`-prefixed ones (texture generation, linear) on 3,648 loads; no bit above `0x200000` is ever set (histogram in the JSON, `geometryModes`).

## 2. Normals

They reach the vertex data and survive up to `load_vertices`; they are dropped at `emit`.

Vertex layout when lit (`dl.c:786-803`): `x y z` s16, flags u16, `s t` s16, then `nx ny nz` s8 and alpha u8. Real vertices from the capture above (`0101602c 0300ab10`, segment 3):

```
fa 8e 02 22 f9 91 00 00 e0 00 08 00 | 48 00 5f | ff     n = (72, 0, 95)  |n| = 119.2
05 28 02 3f f8 ac 00 00 20 00 08 00 | 2c 00 6f | ff     n = (44, 0, 111) |n| = 119.4
```

Lengths, all 4,239,126 lit vertices (probe `lengthBytes`): 119 → 2,425,819; 120 → 1,781,147 (together 99.4%); 126-127 → 7,061; 0 → 2,980 (zero normals); the rest are scattered. So normals are unit vectors scaled to about 119.5 (0.94 of 127), not 127: the game authors unit normals at ~119.5. The microcode does not normalise (`display-lists.md` §9), so a surface facing a light gets about 0.94 of the light's colour before the light vector's own length is applied.

Plausibility against the mesh: for every lit triangle (2,838,100 with a non-degenerate geometric normal) the geometric normal from the model-space positions was compared with the sum of its three vertex normals:

| cos | triangles |
| --- | --- |
| > 0.9 | 63.1% |
| 0.5 to 0.9 | 21.4% |
| -0.5 to 0.5 | 5.6% |
| < -0.5 | 9.9% (the triangle is wound opposite to its normal: double-sided or mirrored meshes) |

Mean cosine 0.70. Normals are therefore smooth vertex normals pointing out of the mesh's front faces, as expected, with a minority that is flat-shaded across a hard edge (cos 0.5-0.9) or reversed. They are usable.

## 3. Lights

Per draw group the game writes a block into RAM and points MOVEMEM at it (the `DC` words above). Layout seen at the forest (`0x80174400`):

```
80174400  50 50 50 01 50 50 50 00 | 46 46 5a 00 46 46 5a 00 00 88 ec 22 00 00 00 01 | ff ff ff 00 ff ff ff 00 00 78 14 00 00 00 00 00
          ambient (8 bytes)          light 0 (16 bytes: colour, colour copy, direction, then 4 more)        light 1 (16)
```

A light is `r g b p r g b 0 dx dy dz q` + 4 bytes: colour twice, signed direction (here (0,-120,-20), length 121.6, and (0,120,20)), and two bytes (`p` at +3, `q` at +11) whose values vary from draw to draw (`p` took over 150 distinct values in the sample). The ambient is a colour and nothing else.

- Directional lights only: 2 to 4 per draw, ambient colour. The direction bytes are in the same ~120 scale as the normals.
- No evidence of positional lights: the geometry mode never has a bit above `0x200000` (no mode bit to select them), and the microcode itself, executed on the forest task (`tools/gfx/ucode-compare.ts`, result `colourError 1`, `positionError 0.12`, `coverageDifference 0.04%`, 3,621 vertices) lights those vertices as `dl.c` does, which ignores `p` and `q` (some records there carry `p = 0x52`, `q = 0x13`). So the extra bytes do not act in the microcode used by this game. What they hold is unexplained (not claimed).
- Light sets repeat in groups: the commonest sets of the 100 scenes are scene-wide pairs, e.g. `L0 c8dce6 dir (27,-6,-123), L1 f0dcbe dir (-24,68,104), amb 191919`, or the forest's `L0 32325a dir (13,-119,-19), L1 fffff0 dir (-13,119,19), amb 695a5a` (JSON `lightSets`). The two directions are nearly opposite in most sets (a key and a fill from the other side).
- Source: every record seen lives in RAM at `0x80171xxx`-`0x80186xxx`, which is where the lists themselves are built (the lists at `0x8017ac10`, `0x8024dc30`); the game writes it at draw time. Where the game derives the colours and directions from (a scene-header record changing with the time of day is the obvious candidate) was not traced; the next step does this.
- Light vectors are model-view dependent (`dl.c:498`): an actor's scale-0.01 matrix makes the vector ~1.2 long, so actor lights come out ~1.2 times brighter than a scene's with its unit-length vector (`display-lists.md` §9). Per-pixel lighting has to keep this.

## 4. What is lit

Triangle shares over the sample (a triangle is lit when its three vertices were loaded with the lighting bit on):

| | triangles | share |
| --- | --- | --- |
| lit | 2,857,294 | 76.8% |
| unlit | 863,799 | 23.2% |

The assumption that level geometry is mostly baked is wrong for this game: by VTX segment of the first vertex (probe `litBySegment`, `unlitBySegment`) segment 3 (the room geometry called through `0300xxxx` in the capture) is 756,422 lit against 559,343 unlit, and segment 6 (the small-scale objects below) is 2,046,389 lit against 115,796 unlit. By model-view scale (length of the matrix's first row): 788,000 lit triangles at scale ≥ 1 (scene geometry), 129,000 at 0.1-1, 206,000 at 0.01-0.1 and 1.73 million at 0.001-0.01 (actor-sized matrices, display-lists.md §9). Per scene the lit share ranges from 0% (scene 71, nothing lit) and 38% (scenes 21, 19) to 98-100% (11 scenes); median about 77%. Segment attributions to "room" and "actors" are inferred from the matrix scales and the capture, not proven.

What the unlit triangles are (probe `byClass`, `unlitVarying`): 522,754 have vertex colours that differ across the triangle (baked gradients, painted shadow/glow, mostly in room segment 3), 341,045 are flat; 552,619 of the unlit use the shade colour in the combiner (baked vertex colour × texture); 308,820 use no shade (primitive/environment colour or texture only: UI-like and effects). Fog uses vertex alpha for 2,780,990 of the 2,857,294 lit triangles (97%), so for lit geometry alpha is the fog factor, not opacity.

The lit shade is used: 2,700,507 of 2,857,294 lit triangles (94.5%) have the shade colour in the combiner; 155,467 (5.4%) do not (lit vertices whose colour the combiner ignores; waste or effect draws). Shade alpha is read by only 3,680 triangles in total.

Texture generation (environment-style mapping, UV from normal · look-at vectors): 51,222 lit triangles (1.8%), modes `0x2e`/`0x2f` (linear). These are the only existing reflection-like effects.

## 5. Options

Common groundwork for A to C: `load_vertices` would also emit the normal (and the light set), `GfxBatch` and the clipper would carry it (`dl.c:961` and the clip interpolation), `renderer.ts` vertex format grows from 10 to 13 floats (+30% vertex bandwidth) or 10 + 4 packed bytes, `shader.ts` computes shade from interpolated normals. Because dot products are linear, the vertex result is `ambient + sum colour · max(0, n·L')`; the only differences between per-vertex and per-pixel are the `max(0, …)` and the cap at the pixel, and the normal's length after interpolation.

**A. Per-pixel diffuse from the recovered normals and lights.**
- Work: emit the normal rotated by the model-view into a common space; per batch pass the light set as uniforms (light state must become part of the batch key; light sets change per draw group, so batches split more) or per vertex the light vectors (heavier). Keep `model_direction()` to reproduce the 1.2x/dim behaviour, and the normal length (~119.5, then renormalise to ~120 per pixel). Fog and alpha stay on the vertex path. The shade interpolation is screen-linear on the console (`shader.ts:371-375`); normals would be perspective-correct or the same trick.
- Gain: moderate and mostly on low-poly lit models and large room triangles: a sharper, correct terminator (`max(0)` at the pixel) and no Gouraud streaks across large triangles. With two nearly opposite lights the interior of faces rarely goes to zero, so many surfaces look near identical to today.
- Risks: baked-in looks tuned for vertices (reversed or flat normals, 9.9% of triangles with cos < -0.5, would show faceting or dark patches); lit draws whose combiner ignores shade (5.4%) cost work for nothing; the fragment cost is small. Differences with Gouraud may read as "wrong" to someone who wants the N64 look: needs a toggle.

**B. Specular term.**
- Work: A, plus a view vector per pixel from the clip position, a shininess constant (the data has none: no per-material field exists in the 16-byte vertex or in the light records), and a mask (specular on stone/metal/water but not on cloth/grass) which does not exist in this data. A global constant makes everything glossy.
- Gain: highest wow per effort but least faithful; will look wrong without a mask.
- Risks: high, given no material data. Recommend not before A.

**C. Normal maps.** Needs authored tangent-space textures and tangents; neither exists in the ROM (textures are the game's, vertices carry no tangent), and generating them from the colour textures is a different project. Out of scope.

**D. Environment and reflection.** Only 1.8% of lit triangles use texture generation. Per-pixel recomputation of the generated UV from the interpolated normal would remove the faceting of the sphere-map look on those items. Small gain, needs A's normal anyway. A real reflection of the scene (screen-space or probes) has no data to build on.

**E. Point lights** (torches, fairies): the game has none in the lighting data (§3); doing them would be new content by the port, with the actor positions from `docs/re/actors.md`: possible but a separate feature.

Do not touch unlit baked geometry (23% of triangles): vertex colour there is authored shade (shadows, glow), and effects that use shade for other purposes (fog in alpha, shade alpha read by 3,680 triangles) must be left on the vertex path.

## 6. Recommendation and next step

Recommendation: implement A as an optional mode, off by default, in two stages, and skip B to D until A is judged on screen. Confidence: about 90% that A is technically feasible exactly as described (the data is all there and measured); about 60% that it is visually worth the added code, because the game's vertex lighting already uses smooth authored normals and two nearly opposite directional lights, and the visible gain is limited to terminators and large triangles.

Strongest argument against: the gain is small for the cost and risk. The change spreads over the interpreter, the clipper, the result struct, the batcher (light state splits batches), the renderer and the shader, grows every vertex by 30%, and ships a look the N64 never had on 9.9% reversed-normal triangles; the user's other tasks (bloom, sharpening, SSAO) deliver a bigger visible change for far less coupling.

Next task (small and decisive): **per-pixel diffuse prototype**, one lit-draw path.
1. `dl.c`/`gfx.h`: emit the model-view-rotated normal and, per batch, the two (or more) light vectors and colours and the ambient; add them to the batch state so equal light sets still merge.
2. `renderer.ts`/`shader.ts`: a `lightingMode` setting (`vertex` default, `pixel`); in pixel mode the shader replaces `shade.rgb` for lit batches by `ambient + sum colour · max(0, n·L')` with the exact scaling above, keeping alpha/fog from the vertex.
3. Check: with normals un-interpolated (flat per-vertex test) the pixel result must equal the vertex colour within 2/255 (the same tolerance as the microcode comparison), then compare a forest and a house frame.
4. Before that, trace where the light records are written (the scene header's light-settings entry is the candidate): search RAM at the forest for the bytes `32 32 5a`/`ff ff f0`, `69 5a 5a`, and find the writing code. Useful for point lights and day/night but not blocking.

## 7. Per-pixel prototype (option A), measured

Built as the optional `lightingMode` setting (`vertex` default, `pixel`; Graphics tab, key P; stored in `oot.gfx`). Numbers below come from `tools/gfx/px-light-states.ts` (new game to Link's house, entrance 238 for the forest after 2448 frames, entrance 626 for Link's house after 300), `px-light-capture.ts` (headless Chrome, software WebGL, the page at 960x720 with AO, bloom and sharpening off, 10 s each) and `px-light-count.ts` (20 frames, interpreter only). Pictures: `out/px-light/{forest,house}-{vertex,pixel}.png` and `-diff.png` (git-ignored).

How it works:
- `dl.c` (`gfx_set_pixel_lighting`, off by default; nothing extra is produced while off): a lit vertex keeps its model-space normal bytes and the id of its light set. The set holds the ambient colour, the light colours and the light vectors **in the vertices' model space, as `model_direction` leaves them**, so the 1.2x/dimming behaviour and the unnormalised normal (~119.5) carry over unchanged. It is a deviation from "normal rotated by the model-view": rotating the lights instead of the normals gives the same dot products, and the quantised vectors the vertex path uses. Equal sets are shared (last 16 compared), a batch is split when a triangle brings another set, and the web side merges draw runs only on equal sets (`web/batching.ts`).
- Output per vertex: the normal bytes and a flag, packed as four signed bytes in one extra word (`web/renderer.ts`): vertex 10 words = 40 bytes in vertex mode (unchanged, the attribute is off and the interpreter emits nothing), 11 words = 44 bytes in pixel mode (+10%). Clipped triangles interpolate the normal and round it to bytes.
- `web/shader.ts` `PIXEL_LIGHT_GLSL`: `ambient + sum floor(colour * clamp(2 n.L, 0, 32767) / 32768)`, capped at 255, with `n` interpolated screen-linearly like the colour. Alpha, fog, shade alpha and unlit draws stay on the vertex path (the vertex colour is still written and used there).
- Exactness: with one normal at all three vertices the result equals the vertex colour within 2/255 (`web/pixel-light.test.ts`, four matrix scales including 0.01; the test evaluates a TypeScript twin of the GLSL, since the tests have no GL context; the GLSL itself is checked only by the captures).

Which triangles stay on the vertex path (`GfxLightResult`, `RenderStats.lighting`):
- Mixed: vertices lit with different light sets or not all lit. 17.8% of lit triangles in the forest and 20.9% in the house (counts over the 10 s runs), 18% and 20% in the 20-frame count. Not traced; they are most likely the skinned joints of Link, whose vertices come from different matrices (his normals live in different model spaces, so no single light set fits them), which fits the count scaling with a model that is on screen all the time. This is inferred, not proven.
- Reversed (cosine below -0.5 between the sum of the vertex normals and the face normal from the model-space positions in drawing order, the research's 9.9% measure): forest 76 of 813,666 lit triangles (0.01%), house 8,228 of 729,349 (1.1%); 20-frame count 0 of 5,412 and 132 of 4,194 (3.1%).

Rule kept: reversed triangles stay on the vertex path (`GFX_LIGHTS_PIXEL`; `GFX_LIGHTS_PIXEL_ALL` lights them per pixel). I could not show that they look broken: they are 0.01% to 3% of the lit triangles here, no artefact is visible in the two frames, and a run with them lit per pixel differs from the other only in noise of the animation (the two runs are not frame-locked). The rule stays because a reversed normal gives the same wrong lighting per pixel as per vertex, only sharper, so nothing is gained from it. The 9.9% of the research are spread over all scenes; these two scenes have far fewer.

What it looks like: the scene geometry is within noise of vertex mode (mean difference 0.42/255 in the forest, 0.19/255 in the house, mostly animated sparkles and Link; 0.9% and 1.2% of the pixels differ by more than 8). On Link the faces show per-pixel terminators instead of Gouraud streaks (differences up to about 50/255 on his face, tunic and boots). This matches the research's expectation: with two nearly opposite lights few surfaces go to zero, so the gain is small.

Cost (software WebGL in headless Chrome, so GPU times mean little, per game frame, mean of 10 samples; one run each, noise about 0.3 ms):

| scene | mode | CPU ms | display lists ms | submit ms | draw calls |
| --- | --- | --- | --- | --- | --- |
| forest | vertex | 9.73 | 5.97 | 2.46 | 475 |
| forest | pixel | 9.79 | 6.15 | 2.44 | 496 |
| house | vertex | 6.21 | 3.54 | 1.85 | 371 |
| house | pixel | 6.66 | 3.78 | 2.05 | 389 |

Pixel mode adds about 4-5% draw calls (runs split on light sets) and up to 0.4 ms of CPU; vertex mode is the code of before (same vertex size, same programs, no extra output). Not measured on a real GPU.

## 8. Point lights (port-made)

An optional effect (`pointLights`, default off, `pointLightStrength` 0 to 100, default 50; Graphics tab, key Y; stored in `oot.gfx`). The game has no point lights (section 3), so everything below is new content; sources are listed in `docs/re/actors.md` ("Light sources").

How it works:
- **Camera.** While `gfx_set_camera_output` is on, `dl.c` keeps up to three perspective projections of the run (`GfxCameraResult`) and tags every triangle's normal word with the slot of the projection its vertices were transformed under (`1 * per-pixel flag + 2 * slot`; orthographic draws get slot 0). The web side takes the slot with most vertices as the scene camera.
- **Position per pixel.** The fragment shader rebuilds the world position from its window position, depth and 1 / w with the inverse of that projection, the draw's viewport rectangle and the vertex shader's x/y scale (`POINT_LIGHT_GLSL`, checked against the forward projection in `web/point-lights.test.ts`). The normal is the face normal from the screen derivatives of that position, turned towards the eye, so baked geometry without normals gets lit and per-pixel lighting is not required (it works with either lighting mode).
- **Lights.** Position: the actor's world position plus 20 units. Colour (1, 0.5, 0.18), reach 160 units (Link is about 60 high), falloff `(1 - d / reach)^2`, facing term `0.35 + 0.65 * max(n.L, 0)` and none behind the surface; the light is added to the shade colour, so the texture modulates it. Flicker: two sines within about 0.85 to 1.15 per light, phase by index. At most 8 lights per frame, the nearest to the eye (those behind it last).
- **Walls.** Nothing blocks a light between a source and a surface; the facing test and the short reach are all that limit it, so a thin wall can pass light to the other side.
- **Which draws.** Triangles under the scene camera that write depth (opaque and cut-out). Translucent draws (flames, sparks, water) are left alone: lit, their quads showed as boxes. A draw whose combiner does not use the shade colour shows no light.
- **Following a source.** Positions are read from the actor lists at each drawn task, so a moving source's light follows it; the picture in between smoothed frames uses the last read.

Captures (`tools/gfx/point-light-states.ts`, `point-light-capture.ts`; pictures in `out/point-lights/`, 3x scale canvas of 913x685, per-pixel lighting on, bloom/AO/sharpening off, headless Chrome on the GPU, mean of 10 samples; one run each):

| scene | point lights | display lists ms | submit ms | CPU ms | GPU ms | draw calls | displayed fps |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Fire Temple first room, Link at the torches | off | 5.56 | 2.74 | 9.79 | 2.77 | 403 | 119.9 |
| same | on | 6.01 | 3.38 | 10.79 | 2.67 | 396 | 120.0 |

The page ran at the display's 120 Hz in both. The Kakariko-at-night and interior-with-a-fire captures are missing: no fire actor was found there (see actors.md).
