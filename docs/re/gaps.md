# Gaps: what the runtime does not handle yet

Result of the gap sweep: what the game can ask of the runtime (read from the binary), and what it did ask over every entrance of its entrance table (measured). Everything below cites addresses of this ROM. The two big tables at the end are generated (`npm run sweep -- report`) and rewritten between their marker comments.

Reproduce:

```
npm run port -- --coverage --dist dist-cov --generated generated   # coverage build, see "Coverage mode"
npm run sweep -- static                                            # ROM + out/inventory.json -> out/sweep/static.json
npm run sweep -- scenes --dump out/sweep/frames [--shard k/n]      # every entrance as child and adult, 300 frames each (--entrances 697, --ages adult)
npm run sweep -- report                                            # rewrites the generated blocks of this file
```

## Unknown commands do not stop a frame

- **Audio.** `Synth` (`tools/audio/synth.ts`) implements all 24 handlers of the microcode's table (`docs/re/audio.md`). An opcode with no handler is logged once (`audio: unknown command 0x.. skipped`, `Synth.unknownOpcodes`) and skipped, so the rest of the list, including the save of the output buffer, still runs; before, the whole list was dropped and the game replayed the previous buffers.
- **Graphics.** The display-list interpreter in C (`runtime/gfx/dl.c`) never aborted on an unknown opcode: `execute` returns 0, the command is recorded in `GfxResult.unknown` and the list goes on; irregularities (a matrix stack underflow, vertices that are not loaded, a stray half-word) are `problem()` strings and the command is skipped. Only an allocation failure calls `abort()`. What was missing is a log: the reader (`tools/gfx/c-dl.ts`, used by the page and the headless runner) now prints each unimplemented opcode once. Errors stay visible: `unknown` and `problems` are counted in the debug overlay (`web/main.ts`), the headless runner exits with status 4 when any unknown command occurred (`tools/headless/cli.ts`), and the sweep lists them below.
- **Age.** The sweep runs every entrance twice. The flag at `0x801183d4` (`SETUP_FLAG`) selects the setup layers: non-zero gives layers 0 and 1, zero 2 and 3 (the init's derivation at `0x8009B064`-`0x8009B17C`, `setupVariantFor` in `tools/headless/state.ts`). The scripted new game, a child in Link's house, has it non-zero (the sweep checks); the adult runs write 0 before forcing the entrance. Nothing else is changed, so an adult run is the scene's adult layers with the child's save data.
- **Short loops.** The sweep runs the mixer on every audio task and keeps the mono output the game queues (`tools/sweep/loops.ts`). A run is a short loop when the last 8192 samples repeat a stretch of 64 to 32000 samples earlier exactly (all but 0.2%), and the output is audible. The mixer is deterministic, so a stuck sequence or a replayed buffer repeats bit for bit while music does not; the test builds both cases.

## Headless speed

The old 3 frames per second were not the recompiled game. Measured here (video frames are retraces; a game frame is one graphics task, about one per three retraces):

| Run | Before | After |
|---|---|---|
| Guest alone, `-O1` + Asyncify, scripted new game | about 1,700 video fps (6,000 frames in 3.5 s, start-up included) | 3,559 video fps, 1,403 game frames/s (measured again after the other changes) |
| Guest alone, `-O2` (new default) | – | 7,703 video fps, 3,036 game frames/s |
| Display lists interpreted (`--dl`), `-O1` | 16 fps (1,500 frames in 92.7 s) | 578 fps, 236 game frames/s |
| Display lists interpreted, `-O2` | – | 687 fps, 280 game frames/s |
| Every frame drawn into the software rasteriser (`--dump`) | 2 fps (1,000 frames in 8 min 5 s) | unchanged: dumps draw only the 8 frames before each requested frame (`--dump-at`, the sweep) |

- **Cause:** the host. The texture decoder ran a per-texel closure and `switch`, and the interpreter re-decoded every texture of every task (the decoder and its callers took most of the 92 s in the profile). It is now table-driven, with a decode cache keyed by the texel and palette bytes. The software rasteriser is what makes `--dump` slow; that is its job and it was not changed.
- **Optimisation:** the build was `-O1`. `-O2` doubles the guest's speed and halves the wasm (23 MB instead of 47 MB); the game's memory is bit-identical after 19,000 frames of the scripted new game (SHA-1 of RDRAM at frames 3,000, 12,000 and 19,000). `-O2` is now the default of `npm run port` and of the test builds (`DEFAULT_OPTIMIZE` in `tools/port/build.ts`); compiling the largest file takes 30 s instead of 24 s.
- **Asyncify:** left as is. Guest threads are fibers (`runtime/sched.c`), which need it, and the guest alone is far above the target. **The thread mechanism is unchanged** (m4-savestate: nothing to adapt).
- **Target:** at least 20 game frames per second headless is met by a factor of 10 or more even with every display list interpreted. `tools/sweep/sweep.test.ts` asserts more than 20 video fps over 2,500 frames of the scripted new game, on the coverage build.

## Frame time breakdown

Where one game frame (one graphics task) spends its time, headless at `-O2`, scripted new game with Kokiri Forest loaded at frame 19,000 (entrance 238, scene 85; Link under control, the opening cutscene skipped with A taps), mean of the last 300 game frames at frame 21,400, three runs:

```
npm run headless -- --input tools/headless/newgame.input --frames 21400 --entrance 238 --profile --profile-window 300
```

| Phase | ms per game frame | Share |
|---|---|---|
| Game code (the frame call minus the hooks) | 0.69–0.73 | 12% |
| Display lists (`DisplayListInterpreter.run`) | 5.04–5.17 | 88% |
| WebGL submit (`drawTask` + `present`) | n/a headless | – |
| GPU (`EXT_disjoint_timer_query_webgl2`) | n/a headless | – |
| Draw calls per frame | 113.5 | – |

- Display-list processing is about 7 times the game code. Interpreting is the dominant CPU cost before any WebGL call, so porting it (and batching the draw calls) is where the gain is.
- The audio mixer does not run in this measurement (no `--wav`); in the browser it runs inside the frame call as a hook and is left out of the game-code time, like the graphics hook.
- Submit and GPU time need a browser: the debug overlay shows them (GPU as "n/a" when the browser lacks the timer query extension) and they were not measured here. Draw calls headless are counted as the renderer issues them: one per non-empty triangle batch and per rectangle that is not a fill.
- Timing is a handful of `performance.now()` reads per task; browsers round them (about 0.1 ms, 1 ms in some), so single frames are coarse and only the means are meaningful.

After the switch (every consumer on the C interpreter, `dl.ts` deleted), the same command with the display lists read into a `DisplayListResult` as the page reads them (`GfxTask.displayList()`, the same `runDisplayList` as `web/game.ts`):

| Phase | ms per game frame, before (TypeScript) | ms per game frame, after (C) |
|---|---|---|
| Game code | 0.69–0.73 | 0.67–0.98 |
| Display lists | 5.04–5.17 | 0.78–0.91 |
| WebGL submit, GPU | n/a headless | n/a headless |

- The after column is the quietest four of ten runs; the machine was shared with other builds, and the slower runs scaled game code and display lists together (game code 1.4–2.8 ms with display lists 1.2–2.5 ms), so the ratio, about 1 to 1.2, is the stable figure. Display lists went from about 7 times the game code to about equal to it.
- **Browser:** the page now spends this display-list time per game frame (`runDisplayList` in `web/game.ts`, shown as "display lists" in the debug overlay) plus the WebGL submit and GPU phases, which need a browser and were not measured here. The overlay shows all four phases per game frame.

### Display lists in C

The same scripted new game with the display lists run by the interpreter in the module (`runtime/gfx/`, built with the game at `-O2`), 6,000 video frames (2,365 game frames), two runs each, `npx tsx tools/gfx/bench.ts --mode <mode>`:

| Run | Video frames/s | Game frames/s | Display lists, ms per game frame |
|---|---|---|---|
| Game alone (`none`) | 7,872–7,926 | 3,103–3,124 | – |
| TypeScript interpreter (`ts`, measured before it was deleted) | 813–823 | 320–324 | 2.64–2.68 |
| C interpreter, result left in the module (`c`) | 3,393–3,472 | 1,337–1,369 | 0.39 |
| C interpreter and the result read into a `DisplayListResult` (`c-read`) | 2,503–2,604 | 987–1,026 | 0.64–0.66 |

The target was at least 700 game frames per second. Reading the result through `tools/gfx/c-dl.ts` costs 0.25 ms per game frame (it builds one object per state and per batch); a consumer that reads the arrays directly pays less.

## Texture filtering and sharpness

What the WebGL renderer did before this work (read from `web/renderer.ts`, `web/shader.ts`, `web/main.ts`; the game side from `docs/re/display-lists.md`):

- **Resolution.** The 3D image was a whole multiple of 320x240, `ceil(canvas CSS width x devicePixelRatio / 320)` capped at 4 (1280x960 at most). A 960 px canvas on a 2x display got 1280x960 stretched to 1920x1440 by the browser; a phone got the same cap.
- **Sampling.** Every texture is a `NEAREST` GL texture read with `texelFetch`; tile origin, shift, clamp, mirror and mask are applied in the shader (`wrapCoord`). The RDP filter field (other modes bits 13-12) was honoured: 0 samples the nearest texel, any other value (bilinear 2 and average 3) runs the 3-point filter; copy-mode rectangles take the texel under the pixel. The game sets bilinear on every draw (`docs/re/display-lists.md`), so every textured draw used the 3-point filter.
- **Not present:** mip levels (distant tiling textures shimmered), multisampling, any choice of filter.

What it does now (`web/gfx-settings.ts`, key toggles in `web/main.ts`):

- **Resolution.** The 3D image is `canvas CSS width x min(devicePixelRatio, scaleCap)` pixels wide, 4:3, at most 8x320. `scaleCap` defaults to 2 on a coarse pointer and to no cap elsewhere. Scissor, viewport and rectangle edges are rounded to device pixels, so rectangles (HUD, text, copy-mode pictures) meet without seams at a fractional scale; their texture coordinates are not changed.
- **Filter** (`filter`, key F): `n64` (default) is the console's 3-point filter, now three fetches blended with weights; `smooth` is four-texel bilinear; `sharp` makes every draw nearest. A draw that asks for point sampling stays point in `n64` and `smooth`.
- **Soft gradients** (`web/low-contrast.ts`): in `n64`, a draw whose read textures are all gradients (at most 5 % of adjacent texel pairs differ by more than 16 in a channel) uses four-texel bilinear. The title intro's sky is drawn as seven 32x32 CI8 tiles (two-cycle combine, TEXEL0 and TEXEL1 mixed by the primitive alpha 61, bilinear bit set, Bayer dither requested in `otherModeH`) whose colours climb in single 5-bit steps (blue 33, 41, 49); at 2x resolution the 3-point filter cut each contour along a diagonal and showed it as slanted bands across the clouds (frames 450 to 700 of a boot; `sharp` showed the steps as blocks, `smooth` and a switched-off MSAA, mip levels or cut-outs made no difference). The sky textures have 0.3 to 2.7 % such pairs, the logo, horse and HUD textures 28 to 78 %. The game's Bayer dither request is still ignored.
- **Mip levels and anisotropy** (`mipmaps`, `anisotropy`, key H): in the shader, since the wrap and mirror rules need `texelFetch`. The level comes from the screen derivatives of the texel coordinate; taps (at most `anisotropy`, 4 on desktop, 2 on a coarse pointer) are spread along the long side of the footprint, each filtered with the chosen filter at two levels and blended. Only triangle draws, and only a tile whose mask is zero or equals the texture size (a smaller mask repeats part of a texture, and a level of the whole texture would blend the repeat with its neighbours). Rectangles, the HUD and copy mode never use mip levels. Nothing changes where a texel is magnified.
- **MSAA x4** (`msaa`, key G): the colour images and the depth buffer are multisampled renderbuffers, resolved into the textures the video interface presents at the end of each task; 0 samples when the browser offers none.
- **Cut-out edges** (`cutout`: `hard` | `smooth`, key V; `smooth` only takes effect with MSAA): a triangle draw with the RDP alpha compare on, in a z-buffered scene (so not the HUD), no framebuffer blending and not copy mode, writes `cover = clamp((a - blendAlpha) / max(fwidth(a), 1e-4) + 0.5, 0, 1)` as its alpha and runs with `SAMPLE_ALPHA_TO_COVERAGE` instead of `discard` (`web/shader.ts` `alphaTest`). The alpha channel is masked for these draws, so the target keeps the alpha of 1 that every other draw assumes (the canvas has no alpha, and the only reader of destination alpha, the framebuffer blend, assumes 1). Texture rectangles and the 2D draws never take this path, and `hard` or no MSAA gives the program text and pixels of before. Mip levels average thin leaves toward transparent, so with mip levels the alpha is raised by 25 % per level (at most x2) before the test; this heuristic is not tuned against pictures yet.
- **Both alpha paths take it.** The forest's fences, bushes and lattice use the coverage-times-alpha path (`RM_AA_ZB_TEX_EDGE`-style modes: no alpha compare, coverage scaled by alpha), so that path is smoothed too, around alpha 0.5 (`EDGE_THRESHOLD`); a draw with the alpha compare keeps the game's threshold (`uBlend.a`).
- **Comparison:** `npx tsx tools/tex/cutout-compare.ts` then `npx tsx tools/tex/cutout-crops.ts` write `out/tex-compare-cutout/` (ROM-derived, not committed): six Kokiri views (`v1`-`v6`, 1920x1440, MSAA x4, mips on) with `smooth` and `hard` of the same game frame (the page runs a fixed number of frames per step with `?capture`, `web/main.ts`), 1:1 crops of bushes, a lattice, foreground fence rails and two distant fences (v1, mips on), and a swipe-slider `index.html`. Hard and smooth are pixel-identical in the ground and everywhere without cut-outs. At 4x zoom the hard edges show 1-2 pixel steps (bush leaves, lattice posts, distant rails); smooth edges are anti-aliased with no dark or light fringe. The distant fences keep their thickness in smooth (no thinning against hard), so the mip alpha raise stayed at 25 % per level; its effect alone was not isolated.
- **Draw time**, `cutout-compare.ts`, 1920x1440, the scene of save state 1, four alternating 8 s rounds per mode, three runs (the third's rows below; the others agree within noise): hard 60.1 fps, display lists 1.26 ms, submit 1.07 ms, GPU 4.21 ms, 160 draw calls; smooth 60.1 fps, 1.15 ms, 0.87 ms, GPU 3.95 ms, 170 draw calls (the other two runs: GPU hard 4.39 and 3.37 ms, smooth 4.33 and 3.93 ms). Smooth costs nothing measurable on this GPU (RTX 4060 Ti, headless Chrome), far inside the 16.7 ms of 60 Hz; a phone is not measured.
- **Settings** are stored as JSON in `localStorage['oot.gfx']` (`filter`, `msaa`, `scaleCap`, `mipmaps`, `anisotropy`, `cutout`); a missing, unreadable or invalid field takes its default. The overlay shows the 3D size, filter, samples and shader build time.

Measured with `npx tsx tools/gfx/browser-bench.ts` (`tools/gfx/browser-bench.ts`): headless Chrome on this machine (RTX 4060 Ti, ANGLE/D3D11), 60 Hz mode, the scene of save state 1 (Kokiri Forest, Link in front of the Kokiri house), 8 one-second overlay samples after 4 s. "Before" is the old resolution rule with `msaa`, `mipmaps` off. Mobile is an emulated 844x390 viewport at devicePixelRatio 3 with touch emulation, on the same desktop GPU: it checks the resolution cap and the frame rate, not a phone GPU. Pictures are in `out/tex-filter/` (ROM-derived, not committed).

| Screen | Settings | 3D image | fps | submit ms | GPU ms |
|---|---|---|---|---|---|
| desktop, ratio 1 | before | 960x720 | 59.9 | 1.13 | 2.78 |
| | default (n64, msaa, mips) | 960x720 | 60.1 | 1.14 | 3.69 |
| | smooth / sharp / no msaa / no mips | 960x720 | 60.0-60.1 | 0.94-1.16 | 2.96-3.56 |
| desktop, ratio 2 | before | 1280x960 | 60.0 | 0.67 | 2.12 |
| | default | 1920x1440 | 60.1 | 0.68 | 2.96 |
| | smooth / sharp / no msaa / no mips | 1920x1440 | 60.1 | 0.81-0.89 | 3.01-3.36 |
| phone (emulated), ratio 3 | before | 1231x924 | 60.0 | 0.84 | 2.67 |
| | default (cap 2) | 1624x1218 | 60.1 | 0.84 | 3.16 |
| | smooth / sharp / no msaa / no mips | 1624x1218 | 60.0-60.1 | 0.66-0.82 | 2.61-3.10 |

**Shader build time** (the overlay's `programs ... ms to build`, which counts the time the page's thread spends compiling and linking; a fresh Chrome profile, so nothing cached, one configuration per run, desktop ratio 1, `--configs before` and `--configs after-default`): 624 ms before, 681 ms with the new default. A first version that built the mip-level programs at first use took 2.2 s. Now a program with mip levels is started in the background (KHR_parallel_shader_compile when the browser has it; otherwise one per task) and the draws use the same program without mip levels until it is ready, so the first frames cost what the old renderer cost and the mip levels appear a few frames later. A mip program that fails to build leaves its draws on the program without mip levels (logged). A table row after the first in a run reuses the profile's program cache, so build times in later rows (40-100 ms) say nothing about a cold start. The scene's display-list time (about 1 ms) and draw calls (146-147) do not change.

- On this GPU nothing reaches the frame budget (GPU 4.5 ms against 16.7 ms), so the numbers say the cost is small here, not that it is small on a phone. A real phone is not measured; `scaleCap`, `anisotropy` and `msaa` are the levers if one is too slow.
- The tap and level loop has a single filter call to keep the build time down (a version with separate calls per level and tap built far slower: over 1 s of submit time per frame in its window).
- Until a mip program is ready, distant tiling textures shimmer as before; on a browser without parallel compilation this lasts one task per program.
- Mip levels are averages of non-premultiplied RGBA, so a cut-out texture (leaves, grates) can lose or darken its edge with distance; not seen in the forest scene, not checked elsewhere.
- Not checked: other scenes, a real touch device, any effect that reads a colour image back as a texture.

## Interpolated rendering ("Smooth")

The game produces one picture per game frame: one graphics task every third retrace (a 20 ms video frame at 50 Hz, so 16.7 game frames per second; the 117 tasks of the walking run below were spaced 3 video frames apart every time). (In the 60 Hz mode the video frame is 1/60 s and a game frame still takes three of them, 20 per second; times below are counted in video frames, so the mapping is the same.) With the "Smooth" toggle on, the page draws a picture on every display refresh between the last two game frames. It interpolates the matrices the display lists load, never pixels, and draws with the interpreter's own pipeline (lighting, culling, clipping, textures), so everything that is not a matrix is exactly the current game frame's.

How it works (`runtime/gfx/dl.c` "Matrix identity", `tools/gfx/motion.ts`, `tools/gfx/smooth.ts`, `web/game.ts`):

- The game module keeps a copy of RDRAM from the last task (`gfx_keep`, 8 MB static buffer in `runtime/gfx/task.c`, 1.0 ms) and runs the task's display list over that copy with the commands' matrices replaced by interpolated ones (`gfx_run_kept`). Pictures are drawn when the display refreshes, not when the task arrives, so any refresh rate works. The copy is display data: `Game.states` empties it before a state is captured and after one is applied, so a saved state never carries it.
- With the toggle off none of this runs and graphics tasks are drawn as they come, as before. The check: in the headless test, the kept frame run with nothing replaced draws the same pixels as the live run on every frame.

### What names a matrix across frames

A matrix command is named by the path of display-list calls that led to it plus its place in its list:

- a call or branch to a segmented address (segments 1 to 15: the object and scene files) adds that address to the path; one to any other address adds nothing;
- inside a list entered through a segmented address, the command's offset from the list's start;
- inside any other list (the lists the game builds anew each frame), what the list does next: the first call or vertex load after the command, and the matrix commands passed on the way.

Commands of one name (one limb list drawn for several actors) are told apart by their ordinal, the count of earlier commands of that name in the run. Pairing two frames is `matchFrames`: equal numbers of a name pair in order; unequal numbers pair the closest first, so that the ones that stayed keep their partners and the rest are left unmatched.

Evidence for this choice, from the scripted new game in Kokiri Forest (entrance 238, Link and the camera moving):

- **The matrix's address in RDRAM is not stable** and is not used. The game builds the frame's matrices in a pool that alternates between two buffers: the camera's matrix of consecutive tasks was read from 0x174538, 0x186948, 0x174538 and so on (the other matrices likewise), and only 5.0% of the matched matrices were at the same address as their counterpart.
- **A path of raw call targets is not stable either.** The first version numbered the calls to lists the game builds (the n-th call from the same parent). The list that holds the overlays moved to another place in that order on almost every task (its camera matrices got a new name each frame) because the number of such calls before it changes with the actors on screen. Lists at addresses that are not segmented are therefore left out of the path, and the order survives only as the ordinal.
- Result of the final scheme over 300 consecutive game frames (frames 2,000 to 2,900 after the entrance load): 72,912 matrices of 3D work, **72,642 matched (99.63%)**. In the ROM-gated test (`tools/gfx/smooth.test.ts`, 116 game frames while Link walks forward, right, back and left): 27,164 of 27,340 (**99.36%**). The unmatched ones are objects that appear or disappear (the matched/3D counts per frame go 249/249, 251/253, 253/255 ... as objects enter, and back as they leave).

### What is interpolated, and what never is

- 3D work only: a matrix is 3D when the projection in force while it is loaded is a perspective one (`GFX_MTX_PERSPECTIVE`: the third row's last entry is not zero). Matrices loaded under an orthographic projection (the HUD, text, rectangle transforms) are counted apart (about 6 of the roughly 250 matrices of a forest frame) and never replaced. Rectangles, 2D backgrounds (BG commands) and anything else that is not a matrix command are drawn exactly as in the current frame.
- A matrix is taken apart into scale, rotation and translation; rotation is interpolated as a quaternion by spherical interpolation along the shortest arc, scale and translation linearly. The view matrix multiplied into the projection (the camera) is interpolated as eye position plus rotation, because interpolating its own translation swings the eye on an arc when the camera turns on the spot. A matrix that is not rotation, scale and translation (the perspective matrix, a sheared one) is blended entry by entry.
- **Nothing smears.** A matrix with no counterpart in the previous frame is drawn as in the current one. So is a matched one that moved more than a limit (`MOTION_LIMITS`): translation 300 units (Link is 56 tall and runs about 6 per game frame; the fastest things in the forest move under 50), rotation 120 degrees (the shortest way round is ambiguous beyond half a turn), a scale factor changing by more than 4 times either way, or, for a matrix that is not rotation, scale and translation, an entry changing by more than half of its largest value. In the forest run 172 of the 72,642 matched matrices (0.24%) exceeded a limit: objects turning more than 120 degrees per game frame (spinning things, aliased at this rate anyway) and a few that grow from nothing.
- **Camera cuts.** The camera is held to tighter limits (150 units of eye movement, 45 degrees); if any camera matrix of the frame has no counterpart or exceeds them, the whole frame is drawn as it is, so that the picture is the current frame pixel for pixel (checked in the test on every frame by moving the previous camera 1,000 units). A scene change brings new objects without counterparts and, when the camera matrices still pair, a jump of the camera. The forest run had no cut frames in its 300 game frames.
- **Vertices the game writes itself** (limbs it skins on the CPU, water, effects) are not moved by a matrix and keep the current frame's values. Measured as the share of the vertices loaded whose bytes are in no vertex load of the previous frame: **0.3% (300-frame run) to 0.75% (test run) of a forest frame's vertices**. In the title and opening scenes the share is higher (13.8 to 15.5% while Epona and Link are on screen, from the browser's overlay).

### Cost and latency

Measured headless at `-O2` over the 117 tasks of the walking test, on a machine shared with other builds, so read the ratios:

| Step | ms per game frame |
|---|---|
| Copy of RDRAM (`gfx_keep`) | 1.0 |
| The recording run (the copy plus one interpreter run) | 3.2 |
| One picture between frames (replaced matrices, run, read) | 1.9 |
| The plain run of the same list, for comparison | 1.6 |

A picture is drawn per display refresh (a 60 Hz display shows 3 per game frame, a 144 Hz display 8), each costing one interpreter run and one WebGL submit. A picture that cannot change (a cut, or no matrix moves) is drawn once per game frame.

**Latency added: one game frame at most.** The picture at the moment a game frame arrives has its moving matrices at the previous frame's values, and reaches the current frame's values one game-frame interval later (`smoothFraction`: 0 at the frame's arrival, 1 one interval later, held at 1 if the next frame is late; `interpolate(plan, 0)` equals the previous frame's matrices, both unit-tested). What is on screen is therefore the game state one game-frame interval old: 60 ms at the 3-retrace spacing measured above. With smoothing off the finished frame appears at the next retrace (up to 20 ms), so the added delay is that interval minus the retrace: at most 60 ms, and nothing while the toggle is off.

Two sliders next to the toggle tune it (stored in localStorage, `SmoothTuning`): **strength** (0 to 100%, default 50) keeps the picture nearer the current frame, 0 showing the game's own frames only; **catch-up** (25 to 100%, default 50) is the share of a game-frame interval the motion takes to reach the current frame, so 50% halves the added delay and holds the current frame for the rest.

Fast-forward: smoothing is off while Tab is held, tasks are drawn as they come, and the kept frames are dropped (the first frame after is drawn as it is).

### Browser check

Checked in headless Chrome with software GL (SwiftShader; no real display or GPU): with the toggle on, the title scene (3D camera, Epona and Link, the logo drawn in 2D over it) is drawn correctly, the overlay reports every 3D matrix matched for it, the choice is stored in localStorage (`oot.smooth`) and the button takes no keyboard focus. The displayed fps there is limited by the software GL (35 to 53 ms of GPU time per game frame): 37 fps with smoothing off, 18 with it on. So "a new picture on every refresh of a 60 Hz or faster display" is not measured on a real display; the page draws one per `requestAnimationFrame`.
### Browser check on a real GPU

Measured with `tools/port/measure-render.ts` (CDP-driven Chrome; `tools/port/make-forest-state.ts` writes the state it loads: the scripted new game at 60 Hz, entrance 238 at frame 19,000, saved at video frame 21,400, scene 85). Chrome 155.0.8059.82, headless (`--use-angle=d3d11 --enable-gpu`), dev build at `-O2`, 60 Hz mode, `EXT_disjoint_timer_query_webgl2` available. WebGL's `UNMASKED_RENDERER_WEBGL`: **ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Ti, Direct3D11 vs_5_0 ps_5_0)**, so not SwiftShader (the script aborts on a software renderer). **The display refreshes at 120 Hz**: the median `requestAnimationFrame` interval is 8.30 ms (8.33 ms used as the refresh interval, so "over 1.5x" is above 12.5 ms); the game's 60 Hz mode is its video rate, 3 video frames per game frame, so 20 game frames per second and 6 display refreshes per game frame. Link steps left and right on the spot (0.4 s each) in front of his house, so he and the camera move; the script stops if a row's display lists drop below 4,000 commands (he walked into a house: the forest's are 5,000 to 6,500, the houses' about 2,500). Each row is 30 s after an 8 s warm-up (the sliders and toggle are set through the page); the overlay means are the average of 15 samples taken every 2 s. A headed window was tried first and discarded: a window that was covered while the user worked is throttled by Chrome to 1 frame per second, so the headed numbers did not measure the page. Two complete runs agree within 0.1 ms on the intervals and 0.2 ms on the phase means (a third stopped on the forest check); the second:

| Mode | rAF mean (ms) | p95 | p99 | max | frames over 1.5x | game fps | game code (ms) | display lists | submit | CPU per refresh | GPU (per sample) | draw calls per game frame | per refresh |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Smooth off | 8.34 | 8.50 | 8.50 | 9.60 | 0.0 % | 20.0 | 1.489 | 0.922 | 0.778 | 0.53 | 1.974 | 90.3 | 15.0 |
| Smooth on (strength 100 %, catch-up 100 %) | 8.34 | 8.50 | 8.50 | 8.80 | 0.0 % | 20.0 | 1.399 | 9.376 | 4.285 | 2.50 | 1.788 | 556.8 | 92.4 |
| Smooth on (strength 50 %, catch-up 50 %) | 8.34 | 8.50 | 8.50 | 8.70 | 0.0 % | 20.1 | 1.348 | 6.719 | 2.894 | 1.83 | 1.748 | 365.9 | 60.9 |

- The overlay's phases are means per game frame, in ms. With Smooth on a game frame contains 6 pictures, so display lists, submit and draw calls per game frame are the sum of 6 (about 93 draw calls each, the same as the 90 of a plain forest frame: the pictures are the same display list with other matrices). "CPU per refresh" is the overlay's total CPU (game code, display lists, submit) divided by the 6 refreshes of a game frame, and "per refresh" draw calls likewise (with Smooth off the game draws 1 picture in 6 refreshes, the other 5 re-show the image).
- **GPU** is the overlay's value, the mean over timer-query samples: one sample is one task's draws plus the presents since the previous task (`Renderer.collectGpu`), so it is per drawn picture with Smooth on (1.75 to 1.79 ms, 21 % of the 8.33 ms interval) and per game frame (the task plus 3 presents) with Smooth off (1.97 ms).
- Nothing limits the frame rate: every row keeps the display's 120 Hz (no frame over 1.5 intervals; p99 is the refresh interval to within 0.2 ms; the one 9.6 ms maximum is a single frame), the game keeps 20 game frames per second, and a refresh costs 2.5 ms of CPU and 1.8 ms of GPU at most against 8.33 ms.
- The costly piece is the CPU side of Smooth, not the draws: the 6 pictures cost 9.4 ms of display-list work (`gfx_run_kept`) and 4.3 ms of submit per game frame, against 0.9 and 0.8 for the plain draw. Submit is 0.7 ms per picture for about 93 draw calls, 8 µs per call.
- SwiftShader's 18 to 37 fps above is the software rasteriser; on the GPU the same page makes no dropped refresh.

## Cost of the shadow stack

The generated code keeps a shadow stack of its active calls, so that the threads of a saved state can be rebuilt in another build (`docs/runtime.md`, "Portable save states"). Measured on `-O2` builds of the same sources with and without it, guest alone (no hooks), the scripted new game: 3,000 frames of warm-up, then 16,000 timed video frames, the two wasm files run alternately six times each.

| Build | Wall time of 16,000 video frames | Video fps | Game frames/s (a third of the video fps) | wasm | Call sites with a frame |
|---|---|---|---|---|---|
| Without (commit before this change) | 1.52–1.64 s, median 1.54 s | 10,390 | 3,460 | 23.3 MB | – |
| With, calls to functions that cannot suspend left out (the default) | 1.54–1.58 s, median 1.565 s | 10,220 | 3,410 | 25.3 MB | 11,268 of 53,023 |
| With a frame for every call | 1.80 s (best of five) | 8,900 | 2,960 | 32.0 MB | 53,023 |

- **Result: −1.6 % on game code** (limit 10 %). The CPU-time rates of the same runs are 3,100 and 3,050 game frames/s.
- **Why the default leaves calls out:** a frame for every call cost 15 %. Of that, 11 % was the push and pop (`OOT_PUSH`/`OOT_POP`: two loads and three stores of `Cpu` memory per call, the overflow check among them, about 2 %; a build with the pushes and the resume entries removed ran as fast as the original) and 4 % the resume entry of each function. A thread can only be parked inside the OS routines of `blocking_routine`, so only calls that can reach one need a frame; 79 % of the call sites, and with them the hot calls to small leaf routines, have none. Functions that call through the dispatch tables or reach one of the 15 routines of `SUSPENDING_ROUTINES` are the others.
- **Depth:** a build whose shadow stack held 40 words ran the 19,000 frames of the scripted new game without overflowing; the stack holds 1,024.
- **Size and build time:** `code.c` grows from 21.0 MB to 21.3 MB and compiles in about 30 s either way (29–36 s measured, with other builds running); the whole compile of 489 files takes 55–75 s. Generation takes about twice as long, 13 s instead of about 7 s, because the call graph is computed first.
- **Thread descriptions in the scripted new game:** 5,404 bytes, nine threads (172,734 thread samples over 19,200 boundaries). At 19,200 frame boundaries every thread waited at `osRecvMesg` (site 1), the idle loop of `osSetThreadPri` (site 10) or `osContInit` (site 16, 21 times); inside the overlay loader at frames 259–261 and 5,125–5,127. No boundary was refused.

## Coverage mode

`npm run port -- --coverage` builds with `-DOOT_COVERAGE` (`runtime/cov.c`, `runtime/cpu.h`). It records which recompiled functions ran (a bitmap over `0x80000000`–`0x80FFFFFF`, so overlays count at their link addresses), the calls of each replaced OS routine, and the accesses beyond RDRAM (every guest memory access goes through `mem_ptr`, which otherwise wraps silently into RDRAM). RSP tasks by type and microcode are counted in every build (`oot_rsp_task_kind`). A **loop watchdog** counts the loop heads of the generated code: a video frame with more than 200 million iterations traps instead of hanging. The sweep adds the opcodes of every display list and audio command list. Calls of OS routines made through the dispatch table (indirect calls) are not counted.

## How the sweep forces an entrance

- The entrance table is at `0x800F7BF0`: 1,556 four-byte entries (scene byte, spawn byte), ending where the scene table (`0x800F9440`) starts. The play state's init (`0x8009AEA0`) reads the index from the word at `0x801183D0` (`lw` at `0x8009B17C`), adds a setup variant held at `0x80119730` and loads `table[index + variant]` (`0x8009B268`–`0x8009B27C`). The variant is 0–3 for age and time of day, or 4 + the cutscene layer when the cutscene index at `0x801183D8` is `0xFFF0` or more (`0x8009B0E4`–`0x8009B17C`).
- The game's own scene transition (`0x8009BB98`–`0x8009BBD4`) clears the running flag (`+0x98`) of the play context, stores the init routine and context size (`+0x0C` = `0x8009AEA0`, `+0x10` = `0x12518`) and the new index at `0x801183D0`. The sweep does the same from the host (`requestEntrance` in `tools/headless/state.ts`), after clearing the cutscene index, aiming at index = entry − variant.
- It starts from the scripted new game at frame 19,000 (Link in his house, under control), runs 300 retraces per entrance, and carries on from the scene it is in. After a trap, a hang, or a scene other than the one loaded, a fresh game replays the script (about 10 s without display lists). Dumped frames: two per scene (the first entrance that targets it) in `out/sweep/frames`, drawn into the software rasteriser.
- 37 entries name a scene past the scene table (101 records) and are skipped. Results vary slightly from run to run, because the state carries over from entrance to entrance (the three runs made for this task disagreed on a few entrances around the crashes below).

## Ranked gaps

Evidence is in the generated tables below; "scenes" are scene indices of the scene table. Reproduce one entrance with `npm run sweep -- scenes --entrances N --dist dist-cov`.

### Crash (the game stops or hangs)

1. **Loop that never ends in a floor probe at `0x8002F824`** (function `0x8002F798`): scene 7, spawn 2, entrances 694–697. The loop calls `0x8002DF0C` and subtracts `44($s0)` from a height until a test passes (`0x8002F860`: `beq` back to `0x8002F824`). The code reads pointers such as `0x44810002` (the bits of the float 1032.0) 5,852 times, so a structure it expects is not what it is. The cause is not found; check the object and collision data of scene 7.
2. **Byte copy of absurd length in `0x80004F70`** (copy routine, loop at `0x80004FC8`): scene 83 spawn 8 (entrances 1410–1411) and scene 92 spawn 8 (1552–1555). It runs through memory past the 8 MiB end of RDRAM (509 256-byte blocks touched from `0x80800000` up) before the watchdog stops it; the setup-variant word is garbage there (for example `0x797C…`), so memory was already overwritten when it started.
3. **PI access to unmapped cartridge address `0x0096E03C`** (`runtime/pi.c`): scene 6 spawn 4, entrances 1016–1019. The address looks like a ROM offset without the cartridge base; the caller that built it is not found.
4. **"Thread … is runnable but was never created"** (`runtime/sched.c`) and wild pointers (`0x875C0004`, `0x00C61D14`, `0x4080BC08`): scene 93 spawn 18, entrances 1528–1531, in an earlier run (this run ends in scene 85 instead). Another sign of overwritten memory.
5. Items 2–4 look like one family: a wild write or copy early in a scene load that corrupts the OS lists and the save context. A guard on writes beyond RDRAM would find the first culprit; the coverage build already counts them.

### Missing feature

6. **A second graphics microcode.** Opcode `0xDD` (handler `0x1FAC` of the first microcode starts a DMA of `0x1080` bytes: `addiu $s4,$zero,4224` at `0xFB4`, `jal 0xFD8`) loads RSP code from `0x800E3250` (`dd0007ff 000e3250`; the address is built by `0x80080560` and `0x800809FC`, which draw rooms). The text at `0x800E3250` is RSP code with its own entry. The interpreter knows neither `0xDD` nor the commands that follow it (`0x0A`, `0x02`, marked `*`): 234 entrances in 49 scenes. Rendering those scenes needs the second microcode's command set (m4-3d). It is not in the RSP task table because the task still names the first microcode.
7. **Opcodes `0x02` and `0x04`**: 78 and 232 entrances (`02140000 003700ce`, `04000000 000003e8`). Their handler addresses (`0x1C74`, `0x1C5C`) hold zero words in the text image the task points at, as does CULLDL's (`0x1C34`, implemented): the routines live outside the image. Their meaning is not read yet.
8. **Audio opcode `0x0E`** (fixed): 498,709 commands, 415 entrances, 60 scenes in the sweep. The mixer threw on it (`unknown audio command`), which dropped the rest of that command list, including the final save of the output buffer (command `15`). The output buffer (`0x8018cea0`-`0x8018e4a0`, `docs/re/audio.md`) therefore kept its old samples, which the game queued again, so a short stretch of sound looped. Reproduced as adult Link by forcing entrances 922, 926 and 930 (scenes `0x35`, `0x37`, `0x39`, an interior set with the shops of the adult market) over 400 frames: the mixer error was `unknown audio command 0xe`, the last 2 s of output had RMS 524 and a repeat at a lag of 6,430 frames, 0.2 s (autocorrelation 0.68 on the left channel); with the command implemented there is no error and the RMS is about 1,200, as in the other interiors (scenes `0x30`, `0x34`, `0x36`). Entrances 185 (scene `0x2c`) and 206 (scene `0x51`) never use the command and render identically before and after. The handler (`ucode+0xc5c`-`0xca8`, `docs/re/audio.md`) is a gain over a buffer, now in `tools/audio/synth.ts` and checked against the microcode in `tools/audio/synth.test.ts`. Other audio opcodes with handlers but no mixer code: `0x00`, `0x03`, `0x04`, `0x06`, `0x17` (never executed in the sweep); `0x10` is implemented but never executed.
9. **`0xEE` (RDP SET_PRIM_DEPTH)**: 9 entrances, scenes 32, 86, 88, 95. The other unmodelled RDP forwards (`0xE5` texture rectangle flip, `0xEA`–`0xEC`) never appear.
10. **Hardware registers touched by recompiled code, boot only:** `PI_STATUS` (1,144 reads), `SP_DMEM+0xFF4` (104), the cartridge header word at `0xB0000000` and `0xA6000000` (52 each), from functions `0x80001760`, `0x800015F0` and the boot code at `0x80002FF0`. Memory accesses wrap into RDRAM, so these read RDRAM words instead of device values. Only reads were seen; the write sites of the same functions (`0x80001810` and others) did not run. The static table lists all 21 functions with 148 sites.

### Cosmetic

11. **"stray rdp half-word"** (462 entrances): the interpreter meets `0xE1`/`0xF1` outside a texture rectangle; probably commands of the second microcode.
12. **Blank scenes**: no triangle or rectangle in the last 30 retraces for entrances 889–892 (scenes 99 and 46, ending in 94), 1168–1169 (12, ending in 100), 1424–1425 (67, ending in 83) and 1528–1531 (93, ending in 85). In all of them the game itself ended up in a different scene than the entry names, so they are redirects rather than rendering faults (22 entrances in the "another scene" table; 1304–1308 and 1504 shift the variant by the cutscene layer).
13. All dumped frames (two per scene, `out/sweep/frames`, not committed) are not a single colour. Rendering quality is not judged here.

### Recompiler

Nothing blocks. 13,365 functions in 472 images recompile with 0 problems; no direct transfer reaches an address that is not a function; the 734 indirect calls resolve at run time and none hit `missing function` in the sweep; 3 `jr` are neither returns nor jump tables (boot entry and exception vector with constant targets, and `0x80002B80`); 6 data words point into the middle of functions and 1 at uncovered text (below); `ovl_0036` has no text. The sweep ran 4,976 functions (boot 39 of 144, main code 1,795 of 2,963, overlays 3,141 of 10,046); the rest need gameplay or setups other than entering each entrance once.

Follow-ups: find the first wrong write of items 2–4 (guard beyond RDRAM); read the second microcode and opcodes `0x02`/`0x04` (m4-3d); implement audio `0x0E` (m3-audio); check the scene 7 object data; sweep the cutscene layers (the sweep clears the cutscene index).

## Static sweep

<!-- static:begin -->
### RSP tasks

Submitters of tasks to the RSP (callers found in the inventory): `osSpTaskLoad` (0x800d002c) called from `0x800a36ac`; `osSpTaskStartGo` (0x800d01bc) called from `0x800a36ac`; `osSpTaskYield` (0x800d0f80) called from `0x800a33bc`; `osSpTaskYielded` (0x800d2eb0) called from `0x800a39d8`.

| Type | Source | At | Microcode | Data | Used by | Runtime | Seen |
|---|---|---|---|---|---|---|---|
| 1 | builder | `0x800a1a84` | `0x800e1ec0` (0x1000 bytes) | `0x801123c0` | `0x800a1a84` | handled: graphics task: the display-list interpreter and renderer (rt_set_gfx_hook) | yes |
| 2 | builder | `0x800bac40` | `0x800e0f10` (0x1000 bytes) | `0x801120e0` | `0x800bac40` | handled: audio task: the command-list mixer (rt_set_audio_hook) | yes |
| 4 | template | `0x80006760` | `0x800066c0` (0x20 bytes) | `0x80006d20` | `0x800015f0` | handled: completes with the SP event, nothing to run | yes |
| 4 | template | `0x800ef4c0` | `0x800e4b10` (0x1000 bytes) | `0x80112b70` | `0x8005b6e0` | handled: JPEG decode in runtime/jpeg.c | yes |

Microcode texts that code outside the task builders loads by address (physical or KSEG0 form): `0x800e0f10` (built in `0x800bac40`; starts `ori $t2, $zero, 0xfc0; lw $v0, 24($t2); lw $v1, 28($t2)`); `0x800e3250` (built in `0x80080560`, `0x800809fc`; starts `vxor $v0, $v0, $v0[e=0]; lqv $v31[0], 384($zero); lqv $v30[0], 400($zero)`).

Notes: type 1 at `0x800a1a84`: microcode and data pointers come from the descriptor at 0x800fcd80; type 2 at `0x800bac40`: constant microcode pointers; type 4 at `0x80006760`: boot microcode 0x80006560 (0x3e8 bytes); type 4 at `0x800ef4c0`: the code fills in the boot microcode and the data pointer before submitting.

Microcode heads (RSP disassembly of the first words): `0x800e1ec0` = `vor $v0, $v16, $v16[e=0]; lqv $v31[0], 432($zero); lqv $v30[0], 448($zero)`; `0x800e0f10` = `ori $t2, $zero, 0xfc0; lw $v0, 24($t2); lw $v1, 28($t2)`; `0x800066c0` = `sqv $v12[0], 16($zero); ori $at, $zero, 0x4000; mtc0 $at, c0r4`; `0x800e4b10` = `lw $s6, 4($at); lw $s7, 56($at); lw $t8, 60($at)`.

### Graphics microcode opcodes

Microcode text 0x800e1ec0, data 0x801123c0. dispatch at microcode offset 0x120: sra t4,t9,24; sll t3,t4,1; lhu t3,0x36e(t3); jr t3 (table of halfwords at data offset 0x36e, indexed by the signed opcode byte).

| Op | Name | Handler | Status | Why |
|---|---|---|---|---|
| `00` |  | `0x120c` | missing | the microcode forwards it to the RDP; the interpreter does not model it |
| `01` | VTX | `0x14f0` | implemented | microcode routine |
| `02` | MODIFYVTX | `0x1c74` | implemented | microcode routine |
| `03` | CULLDL | `0x1c34` | implemented | microcode routine |
| `04` | BRANCH_Z | `0x1c5c` | implemented | microcode routine |
| `05` | TRI1 | `0x17b4` | implemented | microcode routine |
| `06` | TRI2 | `0x17ac` | implemented | microcode routine |
| `07` | QUAD | `0x17ac` | implemented | microcode routine |
| `08` |  | `0x118c` | missing | the microcode has a routine for it; the interpreter does not |
| `09` | BG_1CYC | – | unsupported-by-design | outside the run of handler addresses of the opcode table (the word read for it, 0x420, is other data): the microcode has no handler |
| `0a` | BG_COPY | – | unsupported-by-design | outside the run of handler addresses of the opcode table (the word read for it, 0x448, is other data): the microcode has no handler |
| `d0` |  | `0x1188` | missing | the microcode has a routine for it; the interpreter does not |
| `d1` |  | `0x1078` | missing | the microcode has a routine for it; the interpreter does not |
| `d2` |  | `0x1188` | missing | the microcode has a routine for it; the interpreter does not |
| `d3` |  | `0x118c` | missing | the microcode has a routine for it; the interpreter does not |
| `d4` |  | `0x118c` | missing | the microcode has a routine for it; the interpreter does not |
| `d5` |  | `0x118c` | missing | the microcode has a routine for it; the interpreter does not |
| `d6` |  | `0x11b8` | missing | the microcode has a routine for it; the interpreter does not |
| `d7` | TEXTURE | `0x1028` | implemented | microcode routine |
| `d8` | POPMTX | `0x104c` | implemented | microcode routine |
| `d9` | GEOMETRYMODE | `0x11d0` | implemented | microcode routine |
| `da` | MTX | `0x10f0` | implemented | microcode routine |
| `db` | MOVEWORD | `0x1038` | implemented | microcode routine |
| `dc` | MOVEMEM | `0x1120` | implemented | microcode routine |
| `dd` | LOAD_UCODE | `0x1fac` | implemented | microcode routine |
| `de` | DL | `0x1000` | implemented | microcode routine |
| `df` | ENDDL | `0x11e4` | implemented | microcode routine |
| `e0` |  | `0x118c` | missing | the microcode has a routine for it; the interpreter does not |
| `e1` | RDPHALF_1 | `0x1030` | implemented | microcode routine |
| `e2` | SETOTHERMODE_L | `0x1140` | implemented | microcode routine |
| `e3` | SETOTHERMODE_H | `0x113c` | implemented | microcode routine |
| `e4` | TEXRECT | `0x102c` | implemented | microcode routine |
| `e5` | RDP TEXTURE_RECTANGLE_FLIP | `0x102c` | missing | the microcode has a routine for it; the interpreter does not |
| `e6` | RDPLOADSYNC | `0x120c` | implemented | forwarded to the RDP by the microcode |
| `e7` | RDPPIPESYNC | `0x120c` | implemented | forwarded to the RDP by the microcode |
| `e8` | RDPTILESYNC | `0x120c` | implemented | forwarded to the RDP by the microcode |
| `e9` | RDPFULLSYNC | `0x120c` | implemented | forwarded to the RDP by the microcode |
| `ea` | RDP SET_KEY_GB | `0x1208` | missing | the microcode forwards it to the RDP; the interpreter does not model it |
| `eb` | RDP SET_KEY_R | `0x1208` | missing | the microcode forwards it to the RDP; the interpreter does not model it |
| `ec` | RDP SET_CONVERT | `0x1208` | missing | the microcode forwards it to the RDP; the interpreter does not model it |
| `ed` | SETSCISSOR | `0x1244` | implemented | microcode routine |
| `ee` | RDP SET_PRIM_DEPTH | `0x1208` | missing | the microcode forwards it to the RDP; the interpreter does not model it |
| `ef` | SETOTHERMODE | `0x1238` | implemented | microcode routine |
| `f0` | LOADTLUT | `0x1208` | implemented | forwarded to the RDP by the microcode |
| `f1` | RDPHALF_2 | `0x11f8` | implemented | microcode routine |
| `f2` | SETTILESIZE | `0x1208` | implemented | forwarded to the RDP by the microcode |
| `f3` | LOADBLOCK | `0x1208` | implemented | forwarded to the RDP by the microcode |
| `f4` | LOADTILE | `0x1208` | implemented | forwarded to the RDP by the microcode |
| `f5` | SETTILE | `0x1208` | implemented | forwarded to the RDP by the microcode |
| `f6` | FILLRECT | `0x1208` | implemented | forwarded to the RDP by the microcode |
| `f7` | SETFILLCOLOR | `0x1208` | implemented | forwarded to the RDP by the microcode |
| `f8` | SETFOGCOLOR | `0x1208` | implemented | forwarded to the RDP by the microcode |
| `f9` | SETBLENDCOLOR | `0x1208` | implemented | forwarded to the RDP by the microcode |
| `fa` | SETPRIMCOLOR | `0x1208` | implemented | forwarded to the RDP by the microcode |
| `fb` | SETENVCOLOR | `0x1208` | implemented | forwarded to the RDP by the microcode |
| `fc` | SETCOMBINE | `0x1208` | implemented | forwarded to the RDP by the microcode |
| `fd` | SETTIMG | `0x1218` | implemented | forwarded to the RDP by the microcode |
| `fe` | SETZIMG | `0x1218` | implemented | forwarded to the RDP by the microcode |
| `ff` | SETCIMG | `0x1218` | implemented | forwarded to the RDP by the microcode |

First instructions of the handlers the runtime lacks:

- `00` at `0x120c`: `lw $t8, 4072($zero); mfc0 $t3, c0r10; beq $t3, $t8, 0x210; nop`
- `08` at `0x118c`: `sw $t9, 0($s7); j 0x250; addi $s7, $s7, 8; addi $ra, $zero, 4616`
- `d0` at `0x1188`: `sw $t8, 4($s7); sw $t9, 0($s7); j 0x250; addi $s7, $s7, 8`
- `d1` at `0x1078`: `mfc0 $t3, c0r11; andi $t3, $t3, 0x400; bne $t3, $zero, 0x78; addi $t3, $zero, 1`
- `d2` at `0x1188`: `sw $t8, 4($s7); sw $t9, 0($s7); j 0x250; addi $s7, $s7, 8`
- `d3` at `0x118c`: `sw $t9, 0($s7); j 0x250; addi $s7, $s7, 8; addi $ra, $zero, 4616`
- `d4` at `0x118c`: `sw $t9, 0($s7); j 0x250; addi $s7, $s7, 8; addi $ra, $zero, 4616`
- `d5` at `0x118c`: `sw $t9, 0($s7); j 0x250; addi $s7, $s7, 8; addi $ra, $zero, 4616`
- `d6` at `0x11b8`: `sw $t9, 200($zero); j 0x208; sw $t8, 204($zero); sw $t9, 192($zero)`
- `e0` at `0x118c`: `sw $t9, 0($s7); j 0x250; addi $s7, $s7, 8; addi $ra, $zero, 4616`
- `e5` at `0x102c`: `andi $t4, $t4, 0x1; beq $t4, $zero, 0xac; sw $zero, 4036($zero); j 0x164`
- `ea` at `0x1208`: `bne $t3, $zero, 0x200; lw $t8, 4072($zero); mfc0 $t3, c0r10; beq $t3, $t8, 0x210`
- `eb` at `0x1208`: `bne $t3, $zero, 0x200; lw $t8, 4072($zero); mfc0 $t3, c0r10; beq $t3, $t8, 0x210`
- `ec` at `0x1208`: `bne $t3, $zero, 0x200; lw $t8, 4072($zero); mfc0 $t3, c0r10; beq $t3, $t8, 0x210`
- `ee` at `0x1208`: `bne $t3, $zero, 0x200; lw $t8, 4072($zero); mfc0 $t3, c0r10; beq $t3, $t8, 0x210`

Of 256 opcode values: 15 missing, 42 implemented, 199 unsupported-by-design (the last are the values outside the table).

### Audio microcode opcodes

Microcode text 0x800e0f10, data 0x801120e0. dispatch at microcode offset 0x60: srl at,k0,23; andi at,at,0xfe; lh v0,16(v0); jr v0 (halfword table at data offset 0x10, indexed by the opcode byte).

| Op | Name | Handler | Status | Why |
|---|---|---|---|---|
| `00` | record | `0x1f68` | implemented | handled by the mixer |
| `01` | ADPCM decode | `0x1230` | implemented | handled by the mixer |
| `02` | clear | `0x114c` | implemented | handled by the mixer |
| `03` | multiply | `0x1f18` | implemented | handled by the mixer |
| `04` | add buffers | `0x1e2c` | implemented | handled by the mixer |
| `05` | resample | `0x14f4` | implemented | handled by the mixer |
| `06` | read through positions | `0x1e9c` | implemented | handled by the mixer |
| `07` | FIR filter | `0x1cb0` | implemented | handled by the mixer |
| `08` | set buffers | `0x117c` | implemented | handled by the mixer |
| `09` | repeat block | `0x17cc` | implemented | handled by the mixer |
| `0a` | DMEM copy | `0x11e8` | implemented | handled by the mixer |
| `0b` | load codebook | `0x1aa4` | implemented | handled by the mixer |
| `0c` | mix | `0x1b34` | implemented | handled by the mixer |
| `0d` | interleave | `0x1190` | implemented | handled by the mixer |
| `0e` | gain | `0x1c5c` | implemented | handled by the mixer |
| `0f` | set loop | `0x1220` | implemented | handled by the mixer |
| `10` | copy runs | `0x1784` | implemented | handled by the mixer |
| `11` | take every other sample | `0x1830` | implemented | handled by the mixer |
| `12` | envelope rates | `0x1a20` | implemented | handled by the mixer |
| `13` | envelope mix | `0x1884` | implemented | handled by the mixer |
| `14` | load buffer | `0x1a84` | implemented | handled by the mixer |
| `15` | save buffer | `0x1a94` | implemented | handled by the mixer |
| `16` | envelope volumes | `0x1a48` | implemented | handled by the mixer |
| `17` | widen bytes | `0x1ba0` | implemented | handled by the mixer |

First instructions of the handlers the runtime lacks:



### OS routines

`replaced` = the runtime defines `rt_<id>`; `recompiled` = the game's own code runs and touches nothing but guest memory; `gap` = recompiled code that reads or writes hardware the runtime does not model.

| Routine | Address | Category | Disposition | Reason | Callers | Ran |
|---|---|---|---|---|---|---|
| `boot_entry` | `0x80000400` | boot | recompiled | ordinary code over guest memory: the recompiled original runs | 0 | no |
| `boot_main` | `0x80000498` | boot | recompiled | ordinary code over guest memory: the recompiled original runs | 0 | yes |
| `boot_main_thread` | `0x800005a0` | boot | recompiled | ordinary code over guest memory: the recompiled original runs | 0 | yes |
| `boot_idle_thread` | `0x8000063c` | boot | recompiled | ordinary code over guest memory: the recompiled original runs | 0 | yes |
| `dma_copy_from_rom` | `0x8000099c` | dma | recompiled | ordinary code over guest memory: the recompiled original runs | 4 | yes |
| `dma_serve_request` | `0x80000c4c` | dma | recompiled | ordinary code over guest memory: the recompiled original runs | 1 | yes |
| `dma_manager_thread` | `0x80000de8` | dma | recompiled | ordinary code over guest memory: the recompiled original runs | 0 | yes |
| `dma_request_send` | `0x80000e68` | dma | recompiled | ordinary code over guest memory: the recompiled original runs | 10 | yes |
| `rom_file_load` | `0x80000f30` | dma | recompiled | ordinary code over guest memory: the recompiled original runs | 24 | yes |
| `dma_manager_init` | `0x80000fac` | dma | recompiled | ordinary code over guest memory: the recompiled original runs | 1 | yes |
| `yaz0_decode` | `0x8000122c` | dma | recompiled | ordinary code over guest memory: the recompiled original runs | 1 | yes |
| `osPiGetAccess` | `0x80001f10` | pi | recompiled | ordinary code over guest memory: the recompiled original runs | 5 | yes |
| `osPiRelAccess` | `0x80001f54` | pi | recompiled | ordinary code over guest memory: the recompiled original runs | 5 | yes |
| `osSendMesg` | `0x80001f80` | messages | replaced | rt_osSendMesg in the runtime | 45 | yes |
| `osStopThread` | `0x800020d0` | threads | replaced | rt_osStopThread in the runtime | 1 | no |
| `osRecvMesg` | `0x800021a0` | messages | replaced | rt_osRecvMesg in the runtime | 75 | yes |
| `os_internal_exception_vector` | `0x800025a0` | exceptions | recompiled | ordinary code over guest memory: the recompiled original runs | 0 | no |
| `os_internal_exception` | `0x800025b0` | exceptions | **gap** | recompiled, but it uses MI_MASK, MI_INTERRUPT, SP_STATUS, AI_STATUS, PI_STATUS, MI_MODE, VI_CURRENT, SI_STATUS that the runtime does not model | 0 | no |
| `os_internal_exception_send_event` | `0x80002ad4` | exceptions | recompiled | ordinary code over guest memory: the recompiled original runs | 1 | no |
| `os_internal_enqueue_and_yield` | `0x80002bbc` | threads | **gap** | recompiled, but it uses MI_MASK that the runtime does not model | 7 | no |
| `os_internal_enqueue_thread` | `0x80002cbc` | threads | recompiled | ordinary code over guest memory: the recompiled original runs | 6 | no |
| `os_internal_pop_thread` | `0x80002d04` | threads | recompiled | ordinary code over guest memory: the recompiled original runs | 7 | no |
| `os_internal_dispatch_thread` | `0x80002d14` | threads | **gap** | recompiled, but it uses MI_MASK that the runtime does not model | 4 | no |
| `os_internal_dequeue_thread` | `0x80002ea0` | threads | recompiled | ordinary code over guest memory: the recompiled original runs | 3 | no |
| `osDestroyThread` | `0x80002ee0` | threads | replaced | rt_osDestroyThread in the runtime | 3 | no |
| `osCreateThread` | `0x80003090` | threads | replaced | rt_osCreateThread in the runtime | 14 | yes |
| `osInitialize` | `0x800031e0` | init | replaced | rt_osInitialize in the runtime | 1 | yes |
| `os_internal_set_sr` | `0x80003590` | interrupts | replaced | rt_os_internal_set_sr in the runtime | 1 | no |
| `os_internal_get_sr` | `0x800035a0` | interrupts | replaced | rt_os_internal_get_sr in the runtime | 1 | no |
| `osWritebackDCache` | `0x800035b0` | cache | replaced | rt_osWritebackDCache in the runtime | 9 | yes |
| `osViGetNextFramebuffer` | `0x80003630` | vi | replaced | rt_osViGetNextFramebuffer in the runtime | 2 | no |
| `osCreatePiManager` | `0x80003670` | pi | replaced | rt_osCreatePiManager in the runtime | 1 | yes |
| `os_internal_dev_mgr_main` | `0x800037e0` | pi | **gap** | recompiled, but it uses PI_STATUS that the runtime does not model | 0 | no |
| `os_internal_pi_raw_start_dma` | `0x80003bf0` | pi | **gap** | recompiled, but it uses PI_STATUS, PI_DRAM_ADDR, PI_CART_ADDR, PI_WR_LEN, PI_RD_LEN that the runtime does not model | 0 | no |
| `osVirtualToPhysical` | `0x80003cc0` | memory | recompiled | ordinary code over guest memory: the recompiled original runs | 6 | no |
| `osViBlack` | `0x80003d40` | vi | replaced | rt_osViBlack in the runtime | 3 | yes |
| `osGetThreadId` | `0x80003e00` | threads | replaced | rt_osGetThreadId in the runtime | 9 | yes |
| `osSetIntMask` | `0x80003e20` | interrupts | replaced | rt_osSetIntMask in the runtime | 22 | yes |
| `osViSetMode` | `0x80003ec0` | vi | replaced | rt_osViSetMode in the runtime | 2 | yes |
| `os_internal_probe_tlb` | `0x80003f30` | tlb | replaced | rt_os_internal_probe_tlb in the runtime | 1 | no |
| `osSetEventMesg` | `0x80004110` | events | replaced | rt_osSetEventMesg in the runtime | 7 | yes |
| `osUnmapTLBAll` | `0x800041d0` | tlb | replaced | rt_osUnmapTLBAll in the runtime | 1 | no |
| `osEPiStartDma` | `0x80004220` | pi | replaced | rt_osEPiStartDma in the runtime | 7 | yes |
| `osInvalICache` | `0x80004300` | cache | replaced | rt_osInvalICache in the runtime | 5 | yes |
| `osCreateMesgQueue` | `0x80004380` | messages | replaced | rt_osCreateMesgQueue in the runtime | 43 | yes |
| `osInvalDCache` | `0x800043b0` | cache | replaced | rt_osInvalDCache in the runtime | 7 | yes |
| `osJamMesg` | `0x80004490` | messages | replaced | rt_osJamMesg in the runtime | 1 | no |
| `osSetThreadPri` | `0x800045e0` | threads | replaced | rt_osSetThreadPri in the runtime | 6 | yes |
| `os_internal_e_pi_raw_read_io` | `0x800046e0` | pi | **gap** | recompiled, but it uses PI_STATUS, PI_BSD_DOM1_LAT, PI_BSD_DOM1_PGS, PI_BSD_DOM1_RLS, PI_BSD_DOM1_PWD, PI_BSD_DOM2_LAT, PI_BSD_DOM2_PGS, PI_BSD_DOM2_RLS, PI_BSD_DOM2_PWD that the runtime does not model | 2 | no |
| `osViSwapBuffer` | `0x80004840` | vi | replaced | rt_osViSwapBuffer in the runtime | 3 | yes |
| `os_internal_e_pi_raw_start_dma` | `0x80004890` | pi | **gap** | recompiled, but it uses PI_STATUS, PI_DRAM_ADDR, PI_CART_ADDR, PI_WR_LEN, PI_RD_LEN, PI_BSD_DOM1_LAT, PI_BSD_DOM1_PGS, PI_BSD_DOM1_RLS, PI_BSD_DOM1_PWD, PI_BSD_DOM2_LAT, PI_BSD_DOM2_PGS, PI_BSD_DOM2_RLS, PI_BSD_DOM2_PWD that the runtime does not model | 1 | no |
| `osGetTime` | `0x80004a70` | timers | replaced | rt_osGetTime in the runtime | 27 | yes |
| `os_internal_timer_services_init` | `0x80004b00` | timers | recompiled | ordinary code over guest memory: the recompiled original runs | 1 | no |
| `os_internal_timer_interrupt` | `0x80004b8c` | timers | recompiled | ordinary code over guest memory: the recompiled original runs | 1 | no |
| `os_internal_set_timer_intr` | `0x80004d04` | timers | recompiled | ordinary code over guest memory: the recompiled original runs | 2 | no |
| `os_internal_insert_timer` | `0x80004d78` | timers | recompiled | ordinary code over guest memory: the recompiled original runs | 2 | no |
| `osGetCount` | `0x80004f00` | timers | replaced | rt_osGetCount in the runtime | 7 | yes |
| `os_internal_set_global_int_mask` | `0x80004f10` | interrupts | replaced | rt_os_internal_set_global_int_mask in the runtime | 1 | no |
| `os_internal_set_compare` | `0x80004f60` | timers | replaced | rt_os_internal_set_compare in the runtime | 3 | no |
| `os_internal_reset_global_int_mask` | `0x80005280` | interrupts | replaced | rt_os_internal_reset_global_int_mask in the runtime | 1 | no |
| `os_internal_disable_int` | `0x800052e0` | interrupts | replaced | rt_os_internal_disable_int in the runtime | 33 | yes |
| `os_internal_restore_int` | `0x80005350` | interrupts | replaced | rt_os_internal_restore_int in the runtime | 33 | yes |
| `os_internal_vi_init` | `0x80005370` | vi | **gap** | recompiled, but it uses VI_CURRENT, VI_STATUS that the runtime does not model | 1 | no |
| `os_internal_vi_swap_context` | `0x800054b0` | vi | **gap** | recompiled, but it uses VI_CURRENT, VI_ORIGIN, VI_WIDTH, VI_BURST, VI_V_SYNC, VI_H_SYNC, VI_LEAP, VI_H_START, VI_V_START, VI_V_BURST, VI_V_INTR, VI_X_SCALE, VI_Y_SCALE, VI_STATUS that the runtime does not model | 2 | no |
| `osPiGetCmdQueue` | `0x800057b0` | pi | replaced | rt_osPiGetCmdQueue in the runtime | 1 | no |
| `osEPiReadIo` | `0x800057e0` | pi | replaced | rt_osEPiReadIo in the runtime | 11 | yes |
| `osViSetSpecialFeatures` | `0x80005830` | vi | replaced | rt_osViSetSpecialFeatures in the runtime | 1 | yes |
| `os_internal_set_fpc_csr` | `0x80005af0` | interrupts | replaced | rt_os_internal_set_fpc_csr in the runtime | 1 | no |
| `os_internal_get_fpc_csr` | `0x80005b00` | interrupts | replaced | rt_os_internal_get_fpc_csr in the runtime | 0 | no |
| `osEPiWriteIo` | `0x80005b10` | pi | replaced | rt_osEPiWriteIo in the runtime | 8 | no |
| `osMapTLBRdb` | `0x80005b60` | tlb | replaced | rt_osMapTLBRdb in the runtime | 1 | no |
| `osYieldThread` | `0x80005bc0` | threads | replaced | rt_osYieldThread in the runtime | 1 | no |
| `os_internal_get_cause` | `0x80005c10` | interrupts | replaced | rt_os_internal_get_cause in the runtime | 1 | no |
| `os_internal_e_pi_raw_write_io` | `0x80005c20` | pi | **gap** | recompiled, but it uses PI_STATUS, PI_BSD_DOM1_LAT, PI_BSD_DOM1_PGS, PI_BSD_DOM1_RLS, PI_BSD_DOM1_PWD, PI_BSD_DOM2_LAT, PI_BSD_DOM2_PGS, PI_BSD_DOM2_RLS, PI_BSD_DOM2_PWD that the runtime does not model | 2 | no |
| `osSetTimer` | `0x80005d80` | timers | replaced | rt_osSetTimer in the runtime | 6 | yes |
| `osCreateViManager` | `0x80005ec0` | vi | replaced | rt_osCreateViManager in the runtime | 1 | yes |
| `os_internal_vi_mgr_main` | `0x80006040` | vi | recompiled | ordinary code over guest memory: the recompiled original runs | 0 | no |
| `os_internal_vi_get_current_context` | `0x800061d0` | vi | recompiled | ordinary code over guest memory: the recompiled original runs | 1 | no |
| `osStartThread` | `0x800061e0` | threads | replaced | rt_osStartThread in the runtime | 20 | yes |
| `osViSetXScale` | `0x80006330` | vi | replaced | rt_osViSetXScale in the runtime | 1 | yes |
| `osViSetYScale` | `0x80006390` | vi | replaced | rt_osViSetYScale in the runtime | 1 | no |
| `os_internal_set_hw_intr_routine` | `0x800064c0` | events | replaced | rt_os_internal_set_hw_intr_routine in the runtime | 2 | no |
| `pi_handle_create` | `0x800919b0` | pi | recompiled | ordinary code over guest memory: the recompiled original runs | 1 | yes |
| `sram_pi_transfer` | `0x80091a88` | sram | recompiled | ordinary code over guest memory: the recompiled original runs | 1 | yes |
| `sram_transfer` | `0x80091b14` | sram | recompiled | ordinary code over guest memory: the recompiled original runs | 8 | yes |
| `code_entry` | `0x800a2390` | boot | recompiled | ordinary code over guest memory: the recompiled original runs | 1 | yes |
| `osAiSetNextBuffer` | `0x800bc500` | ai | replaced | rt_osAiSetNextBuffer in the runtime | 1 | yes |
| `overlay_relocate` | `0x800cd160` | overlay | recompiled | ordinary code over guest memory: the recompiled original runs | 1 | yes |
| `overlay_load` | `0x800cd428` | overlay | replaced | rt_overlay_load in the runtime | 5 | yes |
| `osGetIntMask` | `0x800cfbe0` | interrupts | replaced | rt_osGetIntMask in the runtime | 0 | no |
| `osSpTaskLoad` | `0x800d002c` | rsp | replaced | rt_osSpTaskLoad in the runtime | 1 | yes |
| `osSpTaskStartGo` | `0x800d01bc` | rsp | replaced | rt_osSpTaskStartGo in the runtime | 1 | yes |
| `os_internal_pfs_select_bank` | `0x800d0200` | controller | recompiled | ordinary code over guest memory: the recompiled original runs | 2 | no |
| `osPfsInit` | `0x800d0474` | controller | replaced | rt_osPfsInit in the runtime | 2 | yes |
| `os_internal_si_create_access_queue` | `0x800d05d0` | si | recompiled | ordinary code over guest memory: the recompiled original runs | 2 | yes |
| `os_internal_si_get_access` | `0x800d0620` | si | recompiled | ordinary code over guest memory: the recompiled original runs | 7 | yes |
| `os_internal_si_rel_access` | `0x800d0664` | si | recompiled | ordinary code over guest memory: the recompiled original runs | 7 | yes |
| `osContInit` | `0x800d0690` | controller | replaced | rt_osContInit in the runtime | 1 | yes |
| `os_internal_cont_get_init_data` | `0x800d0800` | controller | recompiled | ordinary code over guest memory: the recompiled original runs | 2 | no |
| `os_internal_pack_request_data` | `0x800d08d0` | controller | recompiled | ordinary code over guest memory: the recompiled original runs | 2 | no |
| `osContStartReadData` | `0x800d09d0` | controller | replaced | rt_osContStartReadData in the runtime | 1 | yes |
| `osContGetReadData` | `0x800d0a54` | controller | replaced | rt_osContGetReadData in the runtime | 1 | yes |
| `os_internal_pack_read_data` | `0x800d0ae0` | controller | recompiled | ordinary code over guest memory: the recompiled original runs | 1 | no |
| `os_internal_sp_raw_start_dma` | `0x800d0e40` | rsp | replaced | rt_os_internal_sp_raw_start_dma in the runtime | 1 | no |
| `os_internal_si_raw_start_dma` | `0x800d0ed0` | si | **gap** | recompiled, but it uses SI_STATUS, SI_DRAM_ADDR, SI_PIF_ADDR_RD64B, SI_PIF_ADDR_WR64B that the runtime does not model | 8 | no |
| `osSpTaskYield` | `0x800d0f80` | rsp | replaced | rt_osSpTaskYield in the runtime | 1 | yes |
| `osStopTimer` | `0x800d1540` | timers | replaced | rt_osStopTimer in the runtime | 1 | yes |
| `osContStartQuery` | `0x800d1660` | controller | replaced | rt_osContStartQuery in the runtime | 2 | yes |
| `osContGetQuery` | `0x800d16e4` | controller | replaced | rt_osContGetQuery in the runtime | 2 | yes |
| `os_internal_sp_device_busy` | `0x800d2c60` | rsp | replaced | rt_os_internal_sp_device_busy in the runtime | 3 | no |
| `osSpTaskYielded` | `0x800d2eb0` | rsp | replaced | rt_osSpTaskYielded in the runtime | 1 | yes |
| `osAiSetFrequency` | `0x800d3120` | ai | replaced | rt_osAiSetFrequency in the runtime | 1 | yes |
| `osDpGetStatus` | `0x800d3310` | rdp | replaced | rt_osDpGetStatus in the runtime | 1 | no |
| `osDpSetStatus` | `0x800d3320` | rdp | replaced | rt_osDpSetStatus in the runtime | 1 | no |
| `osViSetEvent` | `0x800d36c0` | vi | replaced | rt_osViSetEvent in the runtime | 1 | yes |
| `osAiGetLength` | `0x800d39a0` | ai | replaced | rt_osAiGetLength in the runtime | 1 | yes |
| `os_internal_cont_ram_write` | `0x800d3a50` | controller | recompiled | ordinary code over guest memory: the recompiled original runs | 4 | no |
| `os_internal_pfs_pak_probe` | `0x800d3ca0` | controller | recompiled | ordinary code over guest memory: the recompiled original runs | 2 | no |
| `os_internal_cont_ram_read` | `0x800d4b70` | controller | recompiled | ordinary code over guest memory: the recompiled original runs | 6 | no |
| `os_internal_pfs_get_status` | `0x800d4f10` | controller | recompiled | ordinary code over guest memory: the recompiled original runs | 0 | no |
| `os_internal_sp_get_status` | `0x800d6140` | rsp | replaced | rt_os_internal_sp_get_status in the runtime | 2 | no |
| `os_internal_sp_set_status` | `0x800d6150` | rsp | replaced | rt_os_internal_sp_set_status in the runtime | 4 | no |
| `osWritebackDCacheAll` | `0x800d6160` | cache | replaced | rt_osWritebackDCacheAll in the runtime | 5 | yes |
| `osViGetCurrentFramebuffer` | `0x800d63b0` | vi | replaced | rt_osViGetCurrentFramebuffer in the runtime | 3 | yes |
| `os_internal_sp_set_pc` | `0x800d63f0` | rsp | replaced | rt_os_internal_sp_set_pc in the runtime | 2 | no |

Identified in the inventory but absent from the binary: `osEepromLongRead`, `osEepromLongWrite`, `osEepromProbe`, `osEepromRead`, `osEepromWrite`, `osFlashAllErase`, `osFlashClearStatus`, `osFlashInit`, `osFlashReadArray`, `osFlashReadId`, `osFlashReadStatus`, `osFlashSectorErase`, `osFlashWriteArray`, `osFlashWriteBuffer`, `osMapTLB`, `osSetTLBASID`, `osUnmapTLB`.

### Hardware register accesses outside the replaced routines

168 accesses through constant addresses in the MMIO range were found; 20 sit inside replaced routines and never run. 148 sit in 21 functions that run as recompiled (straight-line base registers only unless marked `across-branch`, where the base register is carried over a branch):

| Function | Image | Owner | Registers | Sites | Ran |
|---|---|---|---|---|---|
| `0x800014ac` | boot | – | SP_STATUS | `0x800014b8` lw | no |
| `0x800015f0` | boot | – | SP_DMEM+0xff4, SP_DMEM+0xffc | `0x80001694` lw, `0x800016a4` lw | yes |
| `0x80001760` | boot | – | PI_STATUS, PI_BSD_DOM1_PGS, PI_BSD_DOM1_RLS, PI_BSD_DOM1_PWD, PI_BSD_DOM1_LAT | `0x800017d0` lw, `0x80001810` sw, `0x8000181c` sw, `0x80001820` sw, `0x8000186c` sw, `0x80001874` sw, `0x8000187c` sw, `0x800017e8` lw (across-branch), `0x800017f4` lw (across-branch), `0x80001804` sw (across-branch), `0x80001864` sw (across-branch) | yes |
| `0x800025b0` | boot | `os_internal_exception` | MI_MASK, MI_INTERRUPT, SP_STATUS, AI_STATUS, PI_STATUS, MI_MODE, VI_CURRENT, SI_STATUS | `0x800026dc` lw, `0x80002874` lw, `0x80002890` lw, `0x800028a8` sw, `0x80002910` sw, `0x80002960` sw, `0x8000298c` sw, `0x800028e4` sw (across-branch), `0x80002934` sw (across-branch) | no |
| `0x80002bbc` | boot | `os_internal_enqueue_and_yield` | MI_MASK | `0x80002c70` lw | no |
| `0x80002d14` | boot | `os_internal_dispatch_thread` | MI_MASK | `0x80002e78` sw | no |
| `0x80003488` | boot | – | PI_BSD_DOM1_LAT, PI_BSD_DOM1_PWD, PI_BSD_DOM1_PGS, PI_BSD_DOM1_RLS, PI_BSD_DOM2_LAT, PI_BSD_DOM2_PWD, PI_BSD_DOM2_PGS, PI_BSD_DOM2_RLS | `0x80003498` lw, `0x800034a8` lw, `0x800034b8` lw, `0x800034c8` lw, `0x800034e4` lw, `0x800034f4` lw, `0x80003504` lw, `0x80003514` lw | no |
| `0x800037e0` | boot | `os_internal_dev_mgr_main` | PI_STATUS | `0x800039dc` sw | no |
| `0x80003bf0` | boot | `os_internal_pi_raw_start_dma` | PI_STATUS, PI_DRAM_ADDR, PI_CART_ADDR, PI_WR_LEN, PI_RD_LEN | `0x80003c08` lw, `0x80003c40` sw, `0x80003c68` sw, `0x80003c8c` sw, `0x80003c98` sw, `0x80003c1c` lw (across-branch), `0x80003c28` lw (across-branch) | no |
| `0x80004460` | boot | – | SI_STATUS | `0x80004464` lw | no |
| `0x800046e0` | boot | `os_internal_e_pi_raw_read_io` | PI_STATUS, PI_BSD_DOM1_LAT, PI_BSD_DOM1_PGS, PI_BSD_DOM1_RLS, PI_BSD_DOM1_PWD, PI_BSD_DOM2_LAT, PI_BSD_DOM2_PGS, PI_BSD_DOM2_RLS, PI_BSD_DOM2_PWD | `0x800046e8` lw, `0x800046fc` lw (across-branch), `0x80004708` lw (across-branch), `0x80004750` sw (across-branch), `0x80004768` sw (across-branch), `0x8000477c` sw (across-branch), `0x80004794` sw (across-branch), `0x800047b0` sw (across-branch), `0x800047c8` sw (across-branch), `0x800047dc` sw (across-branch), `0x800047f0` sw (across-branch) | no |
| `0x80004890` | boot | `os_internal_e_pi_raw_start_dma` | PI_STATUS, PI_DRAM_ADDR, PI_CART_ADDR, PI_WR_LEN, PI_RD_LEN, PI_BSD_DOM1_LAT, PI_BSD_DOM1_PGS, PI_BSD_DOM1_RLS, PI_BSD_DOM1_PWD, PI_BSD_DOM2_LAT, PI_BSD_DOM2_PGS, PI_BSD_DOM2_RLS, PI_BSD_DOM2_PWD | `0x800048a8` lw, `0x800049f0` sw, `0x80004a14` sw, `0x80004a3c` sw, `0x80004a4c` sw, `0x800048bc` lw (across-branch), `0x800048c8` lw (across-branch), `0x80004910` sw (across-branch), `0x80004928` sw (across-branch), `0x8000493c` sw (across-branch), `0x80004954` sw (across-branch), `0x80004970` sw (across-branch), `0x80004988` sw (across-branch), `0x8000499c` sw (across-branch), `0x800049b0` sw (across-branch) | no |
| `0x80005370` | boot | `os_internal_vi_init` | VI_CURRENT, VI_STATUS | `0x8000546c` lw, `0x80005480` lw, `0x80005498` sw | no |
| `0x800054b0` | boot | `os_internal_vi_swap_context` | VI_CURRENT, VI_ORIGIN, VI_WIDTH, VI_BURST, VI_V_SYNC, VI_H_SYNC, VI_LEAP, VI_H_START, VI_V_START, VI_V_BURST, VI_V_INTR, VI_X_SCALE, VI_Y_SCALE, VI_STATUS | `0x800054c8` lw, `0x800056c8` sw, `0x800056d8` sw, `0x800056e8` sw, `0x800056f8` sw, `0x80005708` sw, `0x80005718` sw, `0x8000571c` sw, `0x8000572c` sw, `0x80005738` sw, `0x80005740` sw, `0x8000574c` sw, `0x80005758` sw, `0x80005760` sw | no |
| `0x80005990` | boot | – | PI_STATUS, PI_BSD_DOM1_RLS, PI_BSD_DOM1_PWD, PI_BSD_DOM1_LAT, PI_BSD_DOM1_PGS | `0x800059fc` lw, `0x80005a3c` lw, `0x80005a44` lw, `0x80005a58` sw, `0x80005a5c` sw, `0x80005a9c` sw, `0x80005aa4` sw, `0x80005a14` lw (across-branch), `0x80005a20` lw (across-branch), `0x80005a24` lw (across-branch), `0x80005a30` lw (across-branch), `0x80005a4c` sw (across-branch), `0x80005a50` sw (across-branch), `0x80005a94` sw (across-branch), `0x80005a98` sw (across-branch) | yes |
| `0x80005c20` | boot | `os_internal_e_pi_raw_write_io` | PI_STATUS, PI_BSD_DOM1_LAT, PI_BSD_DOM1_PGS, PI_BSD_DOM1_RLS, PI_BSD_DOM1_PWD, PI_BSD_DOM2_LAT, PI_BSD_DOM2_PGS, PI_BSD_DOM2_RLS, PI_BSD_DOM2_PWD | `0x80005c28` lw, `0x80005c3c` lw (across-branch), `0x80005c48` lw (across-branch), `0x80005c90` sw (across-branch), `0x80005ca8` sw (across-branch), `0x80005cbc` sw (across-branch), `0x80005cd4` sw (across-branch), `0x80005cf0` sw (across-branch), `0x80005d08` sw (across-branch), `0x80005d1c` sw (across-branch), `0x80005d30` sw (across-branch) | no |
| `0x800d0ed0` | code | `os_internal_si_raw_start_dma` | SI_STATUS, SI_DRAM_ADDR, SI_PIF_ADDR_RD64B, SI_PIF_ADDR_WR64B | `0x800d0ee0` lw, `0x800d0f2c` sw, `0x800d0f48` sw, `0x800d0f54` sw | no |
| `0x801cc0e0` | seg_801c4ec0 | – | PI_STATUS, PI_BSD_DOM1_RLS, PI_BSD_DOM1_PWD, 0x6001010, PI_BSD_DOM1_LAT, PI_BSD_DOM1_PGS | `0x801cc0f8` lw, `0x801cc138` lw, `0x801cc140` lw, `0x801cc154` sw, `0x801cc158` sw, `0x801cc160` lw, `0x801cc170` sw, `0x801cc178` sw, `0x801cc110` lw (across-branch), `0x801cc11c` lw (across-branch), `0x801cc120` lw (across-branch), `0x801cc12c` lw (across-branch), `0x801cc148` sw (across-branch), `0x801cc14c` sw (across-branch), `0x801cc168` sw (across-branch), `0x801cc16c` sw (across-branch) | no |
| `0x801d0370` | seg_801c4ec0 | – | PI_STATUS, CART_DOMAIN1_ADDR1+0x508, CART_DOMAIN1_ADDR1+0x510 | `0x801d038c` lw, `0x801d0408` lw, `0x801d0478` sw, `0x801d04f8` sw, `0x801d064c` lw, `0x801d0424` lw (across-branch), `0x801d04d8` lw (across-branch) | no |
| `0x801d08d0` | seg_801c4ec0 | – | PI_STATUS, CART_DOMAIN1_ADDR1+0x510 | `0x801d08e0` lw, `0x801d091c` sw, `0x801d0960` sw, `0x801d08f8` lw (across-branch), `0x801d0904` lw (across-branch), `0x801d0920` lw (across-branch), `0x801d0930` lw (across-branch), `0x801d093c` lw (across-branch), `0x801d0948` sw (across-branch) | no |
| `0x801d0c70` | seg_801c4ec0 | – | PI_STATUS | `0x801d0c94` lw | no |

COP0, cache, TLB and exception instructions outside replaced routines: 699 sites in 149 functions (685 break, 7 mfc0, 6 mtc0, 1 eret). Of these 16 sit in identified OS routines.

### Recompiler

- 13365 functions in 472 images; 377 jump tables recovered; 734 indirect calls (`jalr`), none with a statically known target: they dispatch through the runtime's table at run time and trap with `missing function` when the target is not recompiled.
- `jr` that is neither a return nor a recovered jump table: `0x8000042c` (boot, in `0x80000400`, `$t2`); `0x800025a8` (boot, in `0x800025a0`, `$k0`); `0x80002b80` (boot, in `0x80002ad4`, `$s2`).
- Direct calls or jumps to an address that starts no function: none.
- Text bytes no function covers: none in any image. Images without functions: `ovl_0036` (no text section).
- Data words holding a text address that is not a function entry: 6620 are labels of recovered jump tables; 6 point into a function (`0x800e3454`→`0x800503c4` in `0x800502bc` (code); `0x800e38c8`→`0x800301ec` in `0x8002ff00` (code); `0x800fd808`→`0x800189c0` in `0x80017e18` (code); `0x800fd828`→`0x800189c0` in `0x80017e18` (code); `0x800fd848`→`0x800189c0` in `0x80017e18` (code); `0x800fd868`→`0x800189c0` in `0x80017e18` (code)); 1 point at text no function covers (`0x801d6d48`→`0x801d0000` (seg_801c4ec0)).

### Scene and entrance tables

The entrance table has 1556 entries; the scene table 102 records. 33 entries name a scene past the table (20–39, 71–74, 118–121, 182, 1312–1315); the sweep skips them. 102 different scenes are named by the valid entries.
<!-- static:end -->

## Scene sweep

<!-- scenes:begin -->
Sweep of 1556 entrances as adult and child (3112 runs: 3038 run, 74 skipped as invalid), 300 video frames each, from the game under control at frame 19000; 91 game instance(s) started (1 + recoveries).

Status: 2959 ok, 74 invalid-scene, 40 trap, 39 not-reached. Blank: 3009 no, 29 no-geometry.

Traps and hangs (a game that loops past 200 million iterations in one frame is stopped by the watchdog of the coverage build):

| Message | Hits | Entrances |
|---|---|---|
| watchdog: over 200000000 loop iterations in one video frame, at the loop 0x8002c78c (last function entered: 0x8002bb84) | 4 entrances; scenes 107, 109 | 40–41, 122–123 |
| thread 0xd100b129 is runnable but was never created | 2 entrances; scenes 106 | 75–76 |
| thread 0x39d40000 is runnable but was never created | 1 entrance; scenes 103 | 184 |
| watchdog: over 200000000 loop iterations in one video frame, at the loop 0x8002f824 (last function entered: 0x8002f6dc) | 8 entrances; scenes 7 | 694–699 |
| PI access to unmapped cartridge address 0x0096e03c | 8 entrances; scenes 6 | 1016–1021 |
| watchdog: over 200000000 loop iterations in one video frame, at the loop 0x80004fc8 (last function entered: 0x80004f70) | 11 entrances; scenes  | 1316–1317, 1408–1410, 1552–1555 |
| thread 0xffed0000 is runnable but was never created | 6 entrances; scenes 93 | 1530–1533 |

Unknown display-list commands (a `*` marks commands that follow an opcode 0xdd in the same list):

| Opcode | Hits | First command seen |
|---|---|---|
| `ee` | 67 entrances; scenes 0, 7, 14, 21, 28, 32, 33, 34, 42, 54, 63, 66, 67, 81, 82, 86, 87, 88, 91, 93, 95, 96, 99 | entrance 181: `ee000000 00000000 at 0xfafb8` |

Audio opcodes the mixer rejects:

none.

Display-list problems the interpreter worked around:

none.

Blank frames:

| Kind | Hits | Entrances |
|---|---|---|
| no-geometry | 29 entrances; scenes 83, 85, 94, 100, 101 | 164–165, 873–876, 885–890, 1152–1153, 1166–1167, 1411, 1422–1425, 1512–1515, 1526–1529 |

Entrances after which the play state shows another scene than the entry the game loaded (index plus setup variant) names. The game redirects some entries itself, and an entry with a cutscene setup shifts the variant:

| Entrance | Table scene | Variant | Loaded entry | Its scene | Reached scene |
|---|---|---|---|---|---|
| 164 (child) | 71 | 0 | 164 | 71 | 101 |
| 165 (child) | 71 | 0 | 165 | 71 | 101 |
| 553 (child) | 90 | 0 | 553 | 90 | 93 |
| 554 (child) | 90 | 1 | 554 | 90 | 93 |
| 555 (adult) | 90 | 0 | 553 | 90 | 93 |
| 555 (child) | 90 | 0 | 555 | 90 | 93 |
| 556 (adult) | 90 | 0 | 554 | 90 | 93 |
| 556 (child) | 90 | 1 | 556 | 90 | 93 |
| 557 (adult) | 90 | 1 | 555 | 90 | 93 |
| 558 (adult) | 90 | 1 | 556 | 90 | 93 |
| 885 (child) | 61 | 1 | 885 | 61 | 94 |
| 886 (child) | 61 | 0 | 886 | 61 | 94 |
| 887 (child) | 61 | 0 | 887 | 61 | 94 |
| 888 (child) | 99 | 0 | 888 | 99 | 94 |
| 889 (child) | 99 | 0 | 889 | 99 | 94 |
| 890 (child) | 99 | 0 | 890 | 99 | 94 |
| 1152 (adult) | 100 | 0 | 1150 | 95 | 100 |
| 1153 (adult) | 100 | 0 | 1151 | 95 | 100 |
| 1166 (child) | 12 | 0 | 1166 | 12 | 100 |
| 1167 (child) | 12 | 1 | 1167 | 12 | 100 |
| 1305 (child) | 79 | 4 | 1308 | 26 | 79 |
| 1306 (adult) | 79 | 4 | 1308 | 26 | 79 |
| 1306 (child) | 79 | 4 | 1310 | 26 | 79 |
| 1307 (adult) | 79 | 4 | 1309 | 26 | 79 |
| 1307 (child) | 79 | 4 | 1311 | 26 | 79 |
| 1308 (adult) | 26 | 4 | 1310 | 26 | 79 |
| 1309 (adult) | 26 | 4 | 1311 | 26 | 79 |
| 1422 (child) | 67 | 0 | 1422 | 67 | 83 |
| 1423 (child) | 67 | 0 | 1423 | 67 | 83 |
| 1424 (child) | 67 | 0 | 1424 | 67 | 83 |
| 1425 (child) | 67 | 0 | 1425 | 67 | 83 |
| 1504 (child) | 91 | 4 | 1508 | 76 | 91 |
| 1506 (adult) | 91 | 4 | 1508 | 76 | 91 |
| 1512 (adult) | 85 | 1 | 1510 | 76 | 85 |
| 1513 (adult) | 85 | 1 | 1511 | 76 | 85 |
| 1526 (child) | 67 | 1 | 1526 | 67 | 85 |
| 1527 (child) | 67 | 1 | 1527 | 67 | 85 |
| 1528 (child) | 93 | 0 | 1528 | 93 | 85 |
| 1529 (child) | 93 | 0 | 1529 | 93 | 85 |

Every remaining failure, by scene, age and command (a short loop is output whose last 8192 samples repeat exactly at the period given, in samples at about 32 kHz; the entrances are table entries):

| Kind | Command or message | Scene | Age | Entrances |
|---|---|---|---|---|
| display list | `ee` | 0 | adult | 597, 599 |
| display list | `ee` | 0 | child | 597 |
| display list | `ee` | 7 | adult | 693 |
| display list | `ee` | 7 | child | 693 |
| display list | `ee` | 14 | child | 599 |
| display list | `ee` | 21 | adult | 777 |
| display list | `ee` | 28 | child | 623 |
| display list | `ee` | 32 | adult | 183 |
| display list | `ee` | 32 | child | 181 |
| display list | `ee` | 33 | adult | 609 |
| display list | `ee` | 33 | child | 611, 671 |
| display list | `ee` | 34 | adult | 611 |
| display list | `ee` | 34 | child | 609 |
| display list | `ee` | 42 | child | 765 |
| display list | `ee` | 54 | adult | 765 |
| display list | `ee` | 63 | adult | 800–801 |
| display list | `ee` | 66 | child | 753 |
| display list | `ee` | 67 | child | 800–801 |
| display list | `ee` | 81 | adult | 387, 399, 645, 647, 657, 659 |
| display list | `ee` | 81 | child | 387, 399, 635, 645, 657, 659 |
| display list | `ee` | 82 | adult | 681, 683 |
| display list | `ee` | 82 | child | 681 |
| display list | `ee` | 86 | adult | 259 |
| display list | `ee` | 86 | child | 257 |
| display list | `ee` | 87 | child | 777 |
| display list | `ee` | 88 | adult | 341–344 |
| display list | `ee` | 88 | child | 339–342 |
| display list | `ee` | 91 | adult | 435 |
| display list | `ee` | 91 | child | 435 |
| display list | `ee` | 93 | adult | 705, 729 |
| display list | `ee` | 93 | child | 683, 705, 729 |
| display list | `ee` | 95 | adult | 578–579, 838, 1280 |
| display list | `ee` | 95 | child | 576–577, 836, 1278 |
| display list | `ee` | 96 | adult | 447 |
| display list | `ee` | 96 | child | 447 |
| display list | `ee` | 99 | adult | 741 |
| display list | `ee` | 99 | child | 741 |
| trap | PI access to unmapped cartridge address 0x0096e03c | 6 | adult | 1018–1021 |
| trap | PI access to unmapped cartridge address 0x0096e03c | 6 | child | 1016–1019 |
| trap | thread 0x39d40000 is runnable but was never created | 103 | adult | 184 |
| trap | thread 0xd100b129 is runnable but was never created | 106 | adult | 75–76 |
| trap | thread 0xffed0000 is runnable but was never created | 93 | adult | 1530–1533 |
| trap | thread 0xffed0000 is runnable but was never created | 93 | child | 1530–1531 |
| trap | watchdog: over 200000000 loop iterations in one video frame, at the loop 0x80004fc8 (last function entered: 0x80004f70) | 26 | adult | 1316–1317 |
| trap | watchdog: over 200000000 loop iterations in one video frame, at the loop 0x80004fc8 (last function entered: 0x80004f70) | 83 | child | 1408–1410 |
| trap | watchdog: over 200000000 loop iterations in one video frame, at the loop 0x80004fc8 (last function entered: 0x80004f70) | 92 | adult | 1554–1555 |
| trap | watchdog: over 200000000 loop iterations in one video frame, at the loop 0x80004fc8 (last function entered: 0x80004f70) | 92 | child | 1552–1555 |
| trap | watchdog: over 200000000 loop iterations in one video frame, at the loop 0x8002c78c (last function entered: 0x8002bb84) | 107 | adult | 122–123 |
| trap | watchdog: over 200000000 loop iterations in one video frame, at the loop 0x8002c78c (last function entered: 0x8002bb84) | 109 | adult | 40–41 |
| trap | watchdog: over 200000000 loop iterations in one video frame, at the loop 0x8002f824 (last function entered: 0x8002f6dc) | 7 | adult | 696–699 |
| trap | watchdog: over 200000000 loop iterations in one video frame, at the loop 0x8002f824 (last function entered: 0x8002f6dc) | 7 | child | 694–697 |

2967 of 3038 runs were audible at the end (peak-to-peak range of the last 8192 samples at least 512); 0 of them repeat a short stretch exactly.


Executed RSP tasks: type 4 microcode `0x800066c0` ×91; type 1 microcode `0x800e1ec0` ×901563; type 2 microcode `0x800e0f10` ×2603075; type 4 microcode `0x800e4b10` ×33150.

Graphics opcodes executed (opcode ×count): `01`×64481296 `02`×508481 `03`×4806291 `04`×136143 `05`×19606005 `06`×228993029 `07`×4934600 `0a`×17019 `d7`×35282736 `d8`×486607 `d9`×63617184 `da`×36158716 `db`×33262967 `dc`×28418399 `dd`×34038 `de`×45202970 `df`×41476393 `e1`×4327189 `e2`×21472969 `e3`×29004367 `e4`×4157008 `e6`×69561551 `e7`×139929717 `e8`×14771684 `e9`×292500 `ed`×3568743 `ee`×447 `ef`×10744040 `f0`×12930145 `f1`×4157008 `f2`×76558625 `f3`×49276369 `f4`×7355037 `f5`×128173170 `f6`×888145 `f7`×676282 `f8`×609266 `f9`×877547 `fa`×32208425 `fb`×6911295 `fc`×37081247 `fd`×69561551 `fe`×877500 `ff`×1755188.

Executed graphics opcodes the interpreter lacks: `a`, `ee`.

Audio opcodes executed (opcode ×count): `01`×33283464 `02`×3666301 `05`×30645598 `07`×33910988 `08`×63929062 `09`×94123 `0a`×15912357 `0b`×19463761 `0c`×27431513 `0d`×3600040 `0e`×933544 `0f`×328749 `11`×5100963 `12`×30539046 `13`×30539046 `14`×54454924 `15`×24672879 `16`×30539046.

Audio opcodes the mixer lacks: none; of the implemented ones, never executed: `0`, `3`, `4`, `6`, `10`, `17`.

Coverage: 5037 of 13365 recompiled functions ran (boot 39 of 144, main code 1839 of 2963, overlays 3158 of 10046); 281 of 468 overlays with code had a function run; 61 of 73 replaced OS routines were called (calls made through the dispatch table are not counted). Overlays no function of which ran: `ovl_0031`, `ovl_0037`, `ovl_0039`, `ovl_0043`, `ovl_0045`, `ovl_0047`, `ovl_0050`, `ovl_0057`, `ovl_0058`, `ovl_0062`, `ovl_0064`, `ovl_0065`, `ovl_0068`, `ovl_0069`, `ovl_0070`, `ovl_0071`, `ovl_0072`, `ovl_0073`, `ovl_0075`, `ovl_0084`, `ovl_0085`, `ovl_0086`, `ovl_0087`, `ovl_0088`, `ovl_0089`, `ovl_0093`, `ovl_0095`, `ovl_0098`, `ovl_0099`, `ovl_0100`, `ovl_0101`, `ovl_0105`, `ovl_0106`, `ovl_0110`, `ovl_0111`, `ovl_0114`, `ovl_0116`, `ovl_0117`, `ovl_0118`, `ovl_0121`, `ovl_0123`, `ovl_0126`, `ovl_0128`, `ovl_0132`, `ovl_0133`, `ovl_0135`, `ovl_0136`, `ovl_0138`, `ovl_0139`, `ovl_0142`, `ovl_0149`, `ovl_0150`, `ovl_0153`, `ovl_0155`, `ovl_0161`, `ovl_0166`, `ovl_0167`, `ovl_0170`, `ovl_0171`, `ovl_0172`, `ovl_0173`, `ovl_0177`, `ovl_0178`, `ovl_0180`, `ovl_0182`, `ovl_0183`, `ovl_0184`, `ovl_0188`, `ovl_0189`, `ovl_0193`, `ovl_0194`, `ovl_0195`, `ovl_0203`, `ovl_0204`, `ovl_0208`, `ovl_0212`, `ovl_0215`, `ovl_0216`, `ovl_0218`, `ovl_0221`, `ovl_0222`, `ovl_0225`, `ovl_0226`, `ovl_0227`, `ovl_0228`, `ovl_0229`, `ovl_0231`, `ovl_0241`, `ovl_0243`, `ovl_0245`, `ovl_0248`, `ovl_0249`, `ovl_0250`, `ovl_0251`, `ovl_0255`, `ovl_0259`, `ovl_0268`, `ovl_0269`, `ovl_0270`, `ovl_0271`, `ovl_0277`, `ovl_0278`, `ovl_0279`, `ovl_0280`, `ovl_0281`, `ovl_0283`, `ovl_0285`, `ovl_0288`, `ovl_0296`, `ovl_0297`, `ovl_0300`, `ovl_0301`, `ovl_0305`, `ovl_0306`, `ovl_0307`, `ovl_0310`, `ovl_0311`, `ovl_0313`, `ovl_0315`, `ovl_0316`, `ovl_0320`, `ovl_0321`, `ovl_0328`, `ovl_0332`, `ovl_0334`, `ovl_0336`, `ovl_0340`, `ovl_0342`, `ovl_0345`, `ovl_0346`, `ovl_0353`, `ovl_0361`, `ovl_0366`, `ovl_0367`, `ovl_0374`, `ovl_0375`, `ovl_0376`, `ovl_0378`, `ovl_0380`, `ovl_0383`, `ovl_0386`, `ovl_0389`, `ovl_0391`, `ovl_0392`, `ovl_0393`, `ovl_0397`, `ovl_0398`, `ovl_0399`, `ovl_0400`, `ovl_0402`, `ovl_0403`, `ovl_0404`, `ovl_0405`, `ovl_0406`, `ovl_0408`, `ovl_0409`, `ovl_0410`, `ovl_0411`, `ovl_0412`, `ovl_0413`, `ovl_0416`, `ovl_0417`, `ovl_0418`, `ovl_0419`, `ovl_0420`, `ovl_0421`, `ovl_0422`, `ovl_0423`, `ovl_0426`, `ovl_0431`, `ovl_0435`, `ovl_0436`, `ovl_0439`, `ovl_0461`, `ovl_0462`, `ovl_0463`, `ovl_0465`, `ovl_0467`, `ovl_0469`, `ovl_0476`, `ovl_0480`, `ovl_0483`, `ovl_0486`, `ovl_0488`, `ovl_0490`, `ovl_0492`, `ovl_0498`.

Accesses beyond RDRAM, in 256-byte blocks (the first address touched; the function entered last when it was first touched is only a hint):

Hardware registers and cartridge space (the replaced routines never reach the hardware, so each of these is recompiled code touching a device):

| Address | Register | Accesses | Function entered last | Seen in |
|---|---|---|---|---|
| `0x875c0004` | 0x75c0004 | 18 | `0x800a34b4` | 6 entrances; scenes 93 |
| `0xa4000ff4` | SP_DMEM+0xff4 | 182 | `0x800a34b4` | the scripted start (boot, title, file select, opening) |
| `0xa4600010` | PI_STATUS | 2002 | `0x80002ff0` | the scripted start (boot, title, file select, opening) |
| `0xa6000000` | 0x6000000 | 91 | `0x80002ff0` | the scripted start (boot, title, file select, opening) |
| `0xafaf0148` | CART_DOMAIN2 (SRAM or flash)+0x7af0148 | 2 | `0x80081dd4` | 1 entrance; scenes 107 |
| `0xb0000000` | CART_ROM+0x0 | 91 | `0x80002ff0` | the scripted start (boot, title, file select, opening) |

Other addresses (not a device: a wild pointer, or a read past the end of RDRAM):

| Address | Kind | Accesses | Function entered last | Seen in |
|---|---|---|---|---|
| `0xc61d14` | user segment (unmapped) | 18 | `0x800a34b4` | 6 entrances; scenes 93 |
| `0x1c77829` | user segment (unmapped) | 1 | `0x80081dd4` | 1 entrance; scenes 109 |
| `0x25419300` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25419400` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25419500` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25419600` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25419700` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25419800` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25419900` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25419a00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25419b00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25419c00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25419d00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25419e00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25419f00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541a000` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541a100` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541a200` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541a300` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541a400` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541a500` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541a600` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541a700` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541a800` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541a900` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541aa00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541ab00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541ac00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541ad00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541ae00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541af00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541b000` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541b100` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541b200` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541b300` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541b400` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541b500` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541b600` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541b700` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541b800` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541b900` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541ba00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541bb00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541bc00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541bd00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541be00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541bf00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541c000` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541c100` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541c200` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541c300` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541c400` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541c500` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541c600` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541c700` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541c800` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541c900` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541ca00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541cb00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541cc00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541cd00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541ce00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541cf00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541d000` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541d100` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541d200` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541d300` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541d400` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541d500` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541d600` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541d700` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541d800` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541d900` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541da00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541db00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541dc00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541dd00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541de00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541df00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541e000` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541e100` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541e200` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541e300` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541e400` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541e500` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541e600` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541e700` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541e800` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541e900` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541ea00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541eb00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541ec00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541ed00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541ee00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541ef00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541f000` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541f100` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541f200` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541f300` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541f400` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541f500` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541f600` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541f700` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541f800` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541f900` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541fa00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541fb00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541fc00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541fd00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541fe00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2541ff00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25420000` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25420100` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25420200` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25420300` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25420400` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25420500` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25420600` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25420700` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25420800` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25420900` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25420a00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25420b00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25420c00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25420d00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25420e00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25420f00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25421000` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25421100` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25421200` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25421300` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25421400` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25421500` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25421600` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25421700` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25421800` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25421900` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25421a00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25421b00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25421c00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25421d00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25421e00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25421f00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25422000` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25422100` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25422200` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25422300` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25422400` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25422500` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25422600` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25422700` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25422800` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25422900` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25422a00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25422b00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25422c00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25422d00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25422e00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25422f00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25423000` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25423100` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25423200` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25423300` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25423400` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25423500` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25423600` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25423700` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25423800` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25423900` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25423a00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25423b00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25423c00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25423d00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25423e00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25423f00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25424000` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25424100` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25424200` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25424300` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25424400` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25424500` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25424600` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25424700` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25424800` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25424900` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25424a00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25424b00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25424c00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25424d00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25424e00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25424f00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25425000` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25425100` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25425200` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25425300` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25425400` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25425500` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25425600` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25425700` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25425800` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25425900` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25425a00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25425b00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25425c00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25425d00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25425e00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25425f00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25426000` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25426100` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25426200` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25426300` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25426400` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25426500` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25426600` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25426700` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25426800` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25426900` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25426a00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25426b00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25426c00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25426d00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25426e00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25426f00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25427000` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25427100` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25427200` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25427300` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25427400` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25427500` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25427600` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25427700` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25427800` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25427900` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25427a00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25427b00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25427c00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25427d00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25427e00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25427f00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25428000` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25428100` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25428200` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25428300` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25428400` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25428500` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25428600` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25428700` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25428800` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25428900` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25428a00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25428b00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25428c00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25428d00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25428e00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25428f00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25429000` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25429100` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25429200` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25429300` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25429400` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25429500` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25429600` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25429700` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25429800` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25429900` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25429a00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25429b00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25429c00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25429d00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25429e00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x25429f00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542a000` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542a100` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542a200` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542a300` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542a400` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542a500` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542a600` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542a700` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542a800` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542a900` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542aa00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542ab00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542ac00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542ad00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542ae00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542af00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542b000` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542b100` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542b200` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542b300` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542b400` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542b500` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542b600` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542b700` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542b800` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542b900` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542ba00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542bb00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542bc00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542bd00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542be00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542bf00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542c000` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542c100` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542c200` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542c300` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542c400` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542c500` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542c600` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542c700` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542c800` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542c900` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542ca00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542cb00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542cc00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542cd00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542ce00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542cf00` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542d000` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542d100` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542d200` | user segment (unmapped) | 256 | `0x8000099c` | 1 entrance; scenes 103 |
| `0x2542d300` | user segment (unmapped) | 256 | `0x800a0a30` | 1 entrance; scenes 103 |
| `0x2542d400` | user segment (unmapped) | 256 | `0x800a0a30` | 1 entrance; scenes 103 |
| `0x2542d500` | user segment (unmapped) | 256 | `0x800a0a30` | 1 entrance; scenes 103 |
| `0x2542d600` | user segment (unmapped) | 256 | `0x800a0a30` | 1 entrance; scenes 103 |
| `0x2542d700` | user segment (unmapped) | 256 | `0x800a0a30` | 1 entrance; scenes 103 |
| `0x2542d800` | user segment (unmapped) | 256 | `0x800a0a30` | 1 entrance; scenes 103 |
| `0x2542d900` | user segment (unmapped) | 256 | `0x800a0a30` | 1 entrance; scenes 103 |
| `0x2542da00` | user segment (unmapped) | 256 | `0x800a0a30` | 1 entrance; scenes 103 |
| `0x2542db00` | user segment (unmapped) | 256 | `0x800a0a30` | 1 entrance; scenes 103 |
| `0x2542dc00` | user segment (unmapped) | 256 | `0x800a0a30` | 1 entrance; scenes 103 |
| `0x2542dd00` | user segment (unmapped) | 256 | `0x800a0a30` | 1 entrance; scenes 103 |
| `0x2542de00` | user segment (unmapped) | 256 | `0x800a0a30` | 1 entrance; scenes 103 |
| `0x2542df00` | user segment (unmapped) | 256 | `0x800a0a30` | 1 entrance; scenes 103 |
| `0x2542e000` | user segment (unmapped) | 256 | `0x800a0a30` | 1 entrance; scenes 103 |
| `0x2542e100` | user segment (unmapped) | 256 | `0x800a0a30` | 1 entrance; scenes 103 |
| `0x2542e200` | user segment (unmapped) | 256 | `0x800a0a30` | 1 entrance; scenes 103 |
| `0x2542e300` | user segment (unmapped) | 256 | `0x800a0a30` | 1 entrance; scenes 103 |
| `0x2542e400` | user segment (unmapped) | 256 | `0x800a0a30` | 1 entrance; scenes 103 |
| `0x2542e500` | user segment (unmapped) | 256 | `0x800a0a30` | 1 entrance; scenes 103 |
| `0x2542e600` | user segment (unmapped) | 256 | `0x800a0a30` | 1 entrance; scenes 103 |
| `0x2542e700` | user segment (unmapped) | 256 | `0x800a0a30` | 1 entrance; scenes 103 |
| `0x2542e800` | user segment (unmapped) | 256 | `0x800a0a30` | 1 entrance; scenes 103 |
| `0x2542e900` | user segment (unmapped) | 256 | `0x800a0a30` | 1 entrance; scenes 103 |
| `0x2542ea00` | user segment (unmapped) | 256 | `0x800a0a30` | 1 entrance; scenes 103 |
| `0x2542eb00` | user segment (unmapped) | 256 | `0x800a0a30` | 1 entrance; scenes 103 |
| `0x2542ec00` | user segment (unmapped) | 256 | `0x800a0a30` | 1 entrance; scenes 103 |
| `0x2542ed00` | user segment (unmapped) | 256 | `0x800a0a30` | 1 entrance; scenes 103 |
| `0x2542ee00` | user segment (unmapped) | 256 | `0x800a0a30` | 1 entrance; scenes 103 |
| `0x2542ef00` | user segment (unmapped) | 256 | `0x800a0a30` | 1 entrance; scenes 103 |
| `0x2542f000` | user segment (unmapped) | 256 | `0x800a0a30` | 1 entrance; scenes 103 |
| `0x2542f100` | user segment (unmapped) | 256 | `0x800a0a30` | 1 entrance; scenes 103 |
| `0x2542f200` | user segment (unmapped) | 256 | `0x800a0a30` | 1 entrance; scenes 103 |
| `0x2542f300` | user segment (unmapped) | 256 | `0x800a27c4` | 1 entrance; scenes 103 |
| `0x2542f400` | user segment (unmapped) | 256 | `0x800a27c4` | 1 entrance; scenes 103 |
| `0x2542f500` | user segment (unmapped) | 256 | `0x800a27c4` | 1 entrance; scenes 103 |
| `0x2542f600` | user segment (unmapped) | 256 | `0x800a27c4` | 1 entrance; scenes 103 |
| `0x2542f700` | user segment (unmapped) | 256 | `0x800a27c4` | 1 entrance; scenes 103 |
| `0x2542f800` | user segment (unmapped) | 256 | `0x800a27c4` | 1 entrance; scenes 103 |
| `0x2542f900` | user segment (unmapped) | 256 | `0x800a27c4` | 1 entrance; scenes 103 |
| `0x2542fa00` | user segment (unmapped) | 256 | `0x800a27c4` | 1 entrance; scenes 103 |
| `0x2542fb00` | user segment (unmapped) | 256 | `0x800a27c4` | 1 entrance; scenes 103 |
| `0x2542fc00` | user segment (unmapped) | 256 | `0x800a27c4` | 1 entrance; scenes 103 |
| `0x2542fd00` | user segment (unmapped) | 256 | `0x800a27c4` | 1 entrance; scenes 103 |
| `0x2542fe00` | user segment (unmapped) | 256 | `0x800a27c4` | 1 entrance; scenes 103 |
| `0x2542ff00` | user segment (unmapped) | 256 | `0x800a27c4` | 1 entrance; scenes 103 |
| `0x25430000` | user segment (unmapped) | 256 | `0x800a27c4` | 1 entrance; scenes 103 |
| `0x25430100` | user segment (unmapped) | 256 | `0x800a27c4` | 1 entrance; scenes 103 |
| `0x25430200` | user segment (unmapped) | 256 | `0x800a27c4` | 1 entrance; scenes 103 |
| `0x25430300` | user segment (unmapped) | 256 | `0x800a27c4` | 1 entrance; scenes 103 |
| `0x25430400` | user segment (unmapped) | 256 | `0x800a27c4` | 1 entrance; scenes 103 |
| `0x25430500` | user segment (unmapped) | 256 | `0x800a27c4` | 1 entrance; scenes 103 |
| `0x25430600` | user segment (unmapped) | 256 | `0x800a27c4` | 1 entrance; scenes 103 |
| `0x25430700` | user segment (unmapped) | 256 | `0x800a27c4` | 1 entrance; scenes 103 |
| `0x25430800` | user segment (unmapped) | 256 | `0x800a27c4` | 1 entrance; scenes 103 |
| `0x25430900` | user segment (unmapped) | 256 | `0x800a27c4` | 1 entrance; scenes 103 |
| `0x25430a00` | user segment (unmapped) | 256 | `0x800a27c4` | 1 entrance; scenes 103 |
| `0x25430b00` | user segment (unmapped) | 256 | `0x800a27c4` | 1 entrance; scenes 103 |
| `0x25430c00` | user segment (unmapped) | 256 | `0x800a27c4` | 1 entrance; scenes 103 |
| `0x25430d00` | user segment (unmapped) | 256 | `0x800a27c4` | 1 entrance; scenes 103 |
| `0x25430e00` | user segment (unmapped) | 256 | `0x800a27c4` | 1 entrance; scenes 103 |
| `0x25430f00` | user segment (unmapped) | 256 | `0x800a27c4` | 1 entrance; scenes 103 |
| `0x25431000` | user segment (unmapped) | 256 | `0x800a27c4` | 1 entrance; scenes 103 |
| `0x25431100` | user segment (unmapped) | 256 | `0x800a27c4` | 1 entrance; scenes 103 |
| `0x25431200` | user segment (unmapped) | 256 | `0x800a27c4` | 1 entrance; scenes 103 |
| `0x25431300` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25431400` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25431500` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25431600` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25431700` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25431800` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25431900` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25431a00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25431b00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25431c00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25431d00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25431e00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25431f00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25432000` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25432100` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25432200` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25432300` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25432400` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25432500` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25432600` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25432700` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25432800` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25432900` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25432a00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25432b00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25432c00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25432d00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25432e00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25432f00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25433000` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25433100` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25433200` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25433300` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25433400` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25433500` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25433600` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25433700` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25433800` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25433900` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25433a00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25433b00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25433c00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25433d00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25433e00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25433f00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25434000` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25434100` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25434200` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25434300` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25434400` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25434500` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25434600` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25434700` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25434800` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25434900` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25434a00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25434b00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25434c00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25434d00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25434e00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25434f00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25435000` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25435100` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25435200` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25435300` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25435400` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25435500` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25435600` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25435700` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25435800` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25435900` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25435a00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25435b00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25435c00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25435d00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25435e00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25435f00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25436000` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25436100` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25436200` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25436300` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25436400` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25436500` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25436600` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25436700` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25436800` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25436900` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25436a00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25436b00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25436c00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25436d00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25436e00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25436f00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25437000` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25437100` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25437200` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25437300` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25437400` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25437500` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25437600` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25437700` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25437800` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25437900` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25437a00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25437b00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25437c00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25437d00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25437e00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25437f00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25438000` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25438100` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25438200` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25438300` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25438400` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25438500` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25438600` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25438700` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25438800` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25438900` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25438a00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25438b00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25438c00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25438d00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x25438e00` | user segment (unmapped) | 256 | `0x800a34b4` | 1 entrance; scenes 103 |
| `0x2c021c04` | user segment (unmapped) | 6 | `0x8000099c` | 2 entrances; scenes 106 |
| `0x3365000b` | user segment (unmapped) | 16 | `0x8000099c` | 2 entrances; scenes 106 |
| `0x3365011b` | user segment (unmapped) | 2 | `0x8000099c` | 2 entrances; scenes 106 |
| `0x4080bc08` | user segment (unmapped) | 12 | `0x800a34b4` | 6 entrances; scenes 93 |
| `0x44810002` | user segment (unmapped) | 14630 | `0x8007999c` | 10 entrances; scenes 7 |
| `0x44810130` | user segment (unmapped) | 1000 | `0x80081c38` | 10 entrances; scenes 7 |
| `0x76011e04` | user segment (unmapped) | 6 | `0x8000099c` | 2 entrances; scenes 106 |
| `0x7ffffff4` | user segment (unmapped) | 6 | `0x80035f60` | 2 entrances; scenes 8 |
| `0x80800000` | just past the 8 MiB of RDRAM | 13619 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80800100` | just past the 8 MiB of RDRAM | 13910 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80800200` | just past the 8 MiB of RDRAM | 13538 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80800300` | just past the 8 MiB of RDRAM | 15155 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80800400` | just past the 8 MiB of RDRAM | 13952 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80800500` | just past the 8 MiB of RDRAM | 15275 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80800600` | just past the 8 MiB of RDRAM | 14939 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80800700` | just past the 8 MiB of RDRAM | 14957 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80800800` | just past the 8 MiB of RDRAM | 15860 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80800900` | just past the 8 MiB of RDRAM | 15695 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80800a00` | just past the 8 MiB of RDRAM | 15527 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80800b00` | just past the 8 MiB of RDRAM | 14981 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80800c00` | just past the 8 MiB of RDRAM | 16502 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80800d00` | just past the 8 MiB of RDRAM | 15122 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80800e00` | just past the 8 MiB of RDRAM | 14834 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80800f00` | just past the 8 MiB of RDRAM | 14246 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80801000` | just past the 8 MiB of RDRAM | 14264 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80801100` | just past the 8 MiB of RDRAM | 15512 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80801200` | just past the 8 MiB of RDRAM | 14204 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80801300` | just past the 8 MiB of RDRAM | 14363 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80801400` | just past the 8 MiB of RDRAM | 15305 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80801500` | just past the 8 MiB of RDRAM | 14834 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80801600` | just past the 8 MiB of RDRAM | 16001 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80801700` | just past the 8 MiB of RDRAM | 16067 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80801800` | just past the 8 MiB of RDRAM | 14747 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80801900` | just past the 8 MiB of RDRAM | 15971 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80801a00` | just past the 8 MiB of RDRAM | 14555 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80801b00` | just past the 8 MiB of RDRAM | 15572 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80801c00` | just past the 8 MiB of RDRAM | 14042 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80801d00` | just past the 8 MiB of RDRAM | 14840 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80801e00` | just past the 8 MiB of RDRAM | 14498 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80801f00` | just past the 8 MiB of RDRAM | 14108 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80802000` | just past the 8 MiB of RDRAM | 14168 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80802100` | just past the 8 MiB of RDRAM | 15233 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80802200` | just past the 8 MiB of RDRAM | 15188 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80802300` | just past the 8 MiB of RDRAM | 15344 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80802400` | just past the 8 MiB of RDRAM | 16535 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80802500` | just past the 8 MiB of RDRAM | 14162 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80802600` | just past the 8 MiB of RDRAM | 16310 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80802700` | just past the 8 MiB of RDRAM | 14483 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80802800` | just past the 8 MiB of RDRAM | 13802 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80802900` | just past the 8 MiB of RDRAM | 16178 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80802a00` | just past the 8 MiB of RDRAM | 15140 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80802b00` | just past the 8 MiB of RDRAM | 14915 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80802c00` | just past the 8 MiB of RDRAM | 18509 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80802d00` | just past the 8 MiB of RDRAM | 14822 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80802e00` | just past the 8 MiB of RDRAM | 14684 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80802f00` | just past the 8 MiB of RDRAM | 14372 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80803000` | just past the 8 MiB of RDRAM | 14801 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80803100` | just past the 8 MiB of RDRAM | 15239 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80803200` | just past the 8 MiB of RDRAM | 14894 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80803300` | just past the 8 MiB of RDRAM | 15059 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80803400` | just past the 8 MiB of RDRAM | 16322 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80803500` | just past the 8 MiB of RDRAM | 15092 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80803600` | just past the 8 MiB of RDRAM | 14153 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80803700` | just past the 8 MiB of RDRAM | 14528 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80803800` | just past the 8 MiB of RDRAM | 14996 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80803900` | just past the 8 MiB of RDRAM | 14552 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80803a00` | just past the 8 MiB of RDRAM | 14300 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80803b00` | just past the 8 MiB of RDRAM | 15338 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80803c00` | just past the 8 MiB of RDRAM | 16655 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80803d00` | just past the 8 MiB of RDRAM | 14522 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80803e00` | just past the 8 MiB of RDRAM | 15587 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80803f00` | just past the 8 MiB of RDRAM | 14240 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80804000` | just past the 8 MiB of RDRAM | 14837 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80804100` | just past the 8 MiB of RDRAM | 15062 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80804200` | just past the 8 MiB of RDRAM | 15068 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80804300` | just past the 8 MiB of RDRAM | 14444 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80804400` | just past the 8 MiB of RDRAM | 14696 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80804500` | just past the 8 MiB of RDRAM | 14480 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80804600` | just past the 8 MiB of RDRAM | 15623 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80804700` | just past the 8 MiB of RDRAM | 15521 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80804800` | just past the 8 MiB of RDRAM | 13682 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80804900` | just past the 8 MiB of RDRAM | 15689 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80804a00` | just past the 8 MiB of RDRAM | 15395 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80804b00` | just past the 8 MiB of RDRAM | 15134 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80804c00` | just past the 8 MiB of RDRAM | 15215 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80804d00` | just past the 8 MiB of RDRAM | 15071 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80804e00` | just past the 8 MiB of RDRAM | 14732 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80804f00` | just past the 8 MiB of RDRAM | 16028 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80805000` | just past the 8 MiB of RDRAM | 15707 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80805100` | just past the 8 MiB of RDRAM | 14678 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80805200` | just past the 8 MiB of RDRAM | 15554 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80805300` | just past the 8 MiB of RDRAM | 14159 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80805400` | just past the 8 MiB of RDRAM | 14711 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80805500` | just past the 8 MiB of RDRAM | 15833 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80805600` | just past the 8 MiB of RDRAM | 15281 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80805700` | just past the 8 MiB of RDRAM | 14654 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80805800` | just past the 8 MiB of RDRAM | 14903 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80805900` | just past the 8 MiB of RDRAM | 14951 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80805a00` | just past the 8 MiB of RDRAM | 14318 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80805b00` | just past the 8 MiB of RDRAM | 15230 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80805c00` | just past the 8 MiB of RDRAM | 15212 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80805d00` | just past the 8 MiB of RDRAM | 17609 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80805e00` | just past the 8 MiB of RDRAM | 14441 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80805f00` | just past the 8 MiB of RDRAM | 14525 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80806000` | just past the 8 MiB of RDRAM | 15305 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80806100` | just past the 8 MiB of RDRAM | 14138 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80806200` | just past the 8 MiB of RDRAM | 16418 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80806300` | just past the 8 MiB of RDRAM | 15692 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80806400` | just past the 8 MiB of RDRAM | 16037 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80806500` | just past the 8 MiB of RDRAM | 14036 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80806600` | just past the 8 MiB of RDRAM | 14570 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80806700` | just past the 8 MiB of RDRAM | 14016 | `0x800a34b4` | 23 entrances; scenes 6, 93 |
| `0x80806800` | just past the 8 MiB of RDRAM | 12747 | `0x800a34b4` | 15 entrances; scenes 93 |
| `0x808068ff` | just past the 8 MiB of RDRAM | 9 | `0x80081f50` | 1 entrance; scenes 107 |
| `0x80806900` | just past the 8 MiB of RDRAM | 12954 | `0x800a34b4` | 15 entrances; scenes 93 |
| `0x80806907` | just past the 8 MiB of RDRAM | 12 | `0x80081f50` | 1 entrance; scenes 107 |
| `0x80806a00` | just past the 8 MiB of RDRAM | 13125 | `0x800a34b4` | 15 entrances; scenes 93 |
| `0x80806b00` | just past the 8 MiB of RDRAM | 12150 | `0x800a34b4` | 15 entrances; scenes 93 |
| `0x80806c00` | just past the 8 MiB of RDRAM | 12873 | `0x800a34b4` | 15 entrances; scenes 93 |
| `0x80806d00` | just past the 8 MiB of RDRAM | 12279 | `0x800a34b4` | 15 entrances; scenes 93 |
| `0x80806e00` | just past the 8 MiB of RDRAM | 12240 | `0x800a34b4` | 15 entrances; scenes 93 |
| `0x80806f00` | just past the 8 MiB of RDRAM | 15555 | `0x800a34b4` | 15 entrances; scenes 93 |
| `0x80807000` | just past the 8 MiB of RDRAM | 15051 | `0x800a34b4` | 15 entrances; scenes 93 |
| `0x80807100` | just past the 8 MiB of RDRAM | 14211 | `0x800a34b4` | 15 entrances; scenes 93 |
| `0x80807200` | just past the 8 MiB of RDRAM | 12507 | `0x800a34b4` | 15 entrances; scenes 93 |
| `0x80807300` | just past the 8 MiB of RDRAM | 14259 | `0x800a34b4` | 15 entrances; scenes 93 |
| `0x80807400` | just past the 8 MiB of RDRAM | 12399 | `0x800a34b4` | 15 entrances; scenes 93 |
| `0x80807500` | just past the 8 MiB of RDRAM | 11931 | `0x800a34b4` | 15 entrances; scenes 93 |
| `0x80807600` | just past the 8 MiB of RDRAM | 12054 | `0x8000099c` | 15 entrances; scenes 93 |
| `0x80807700` | just past the 8 MiB of RDRAM | 12174 | `0x8000099c` | 15 entrances; scenes 93 |
| `0x80807800` | just past the 8 MiB of RDRAM | 13017 | `0x8000099c` | 15 entrances; scenes 93 |
| `0x80807900` | just past the 8 MiB of RDRAM | 12066 | `0x8000099c` | 15 entrances; scenes 93 |
| `0x80807a00` | just past the 8 MiB of RDRAM | 11586 | `0x8000099c` | 15 entrances; scenes 93 |
| `0x80807b00` | just past the 8 MiB of RDRAM | 10062 | `0x8000099c` | 15 entrances; scenes 93 |
| `0x80807c00` | just past the 8 MiB of RDRAM | 10200 | `0x8000099c` | 15 entrances; scenes 93 |
| `0x80807d00` | just past the 8 MiB of RDRAM | 10884 | `0x8000099c` | 15 entrances; scenes 93 |
| `0x80807e00` | just past the 8 MiB of RDRAM | 10146 | `0x8000099c` | 15 entrances; scenes 93 |
| `0x80807f00` | just past the 8 MiB of RDRAM | 9594 | `0x8000099c` | 15 entrances; scenes 93 |
| `0x80808000` | just past the 8 MiB of RDRAM | 10773 | `0x8000099c` | 15 entrances; scenes 93 |
| `0x80808100` | just past the 8 MiB of RDRAM | 10563 | `0x8000099c` | 15 entrances; scenes 93 |
| `0x80808200` | just past the 8 MiB of RDRAM | 11829 | `0x8000099c` | 15 entrances; scenes 93 |
| `0x80808300` | just past the 8 MiB of RDRAM | 8763 | `0x8000099c` | 15 entrances; scenes 93 |
| `0x80808400` | just past the 8 MiB of RDRAM | 8589 | `0x8000099c` | 9 entrances; scenes  |
| `0x80808500` | just past the 8 MiB of RDRAM | 8457 | `0x8000099c` | 9 entrances; scenes  |
| `0x80808600` | just past the 8 MiB of RDRAM | 9543 | `0x8000099c` | 9 entrances; scenes  |
| `0x80808700` | just past the 8 MiB of RDRAM | 10530 | `0x8000099c` | 9 entrances; scenes  |
| `0x80808800` | just past the 8 MiB of RDRAM | 8676 | `0x8000099c` | 9 entrances; scenes  |
| `0x80808900` | just past the 8 MiB of RDRAM | 9222 | `0x8000099c` | 9 entrances; scenes  |
| `0x80808a00` | just past the 8 MiB of RDRAM | 9588 | `0x8000099c` | 9 entrances; scenes  |
| `0x80808b00` | just past the 8 MiB of RDRAM | 9036 | `0x8000099c` | 9 entrances; scenes  |
| `0x80808c00` | just past the 8 MiB of RDRAM | 8565 | `0x8000099c` | 9 entrances; scenes  |
| `0x80808d00` | just past the 8 MiB of RDRAM | 9108 | `0x8000099c` | 9 entrances; scenes  |
| `0x80808e00` | just past the 8 MiB of RDRAM | 8673 | `0x8000099c` | 9 entrances; scenes  |
| `0x80808f00` | just past the 8 MiB of RDRAM | 8214 | `0x8000099c` | 9 entrances; scenes  |
| `0x80809000` | just past the 8 MiB of RDRAM | 7848 | `0x8000099c` | 9 entrances; scenes  |
| `0x80809100` | just past the 8 MiB of RDRAM | 6180 | `0x8000099c` | 9 entrances; scenes  |
| `0x80809200` | just past the 8 MiB of RDRAM | 6087 | `0x8000099c` | 9 entrances; scenes  |
| `0x80809300` | just past the 8 MiB of RDRAM | 5568 | `0x8000099c` | 9 entrances; scenes  |
| `0x80809400` | just past the 8 MiB of RDRAM | 6261 | `0x8000099c` | 9 entrances; scenes  |
| `0x80809500` | just past the 8 MiB of RDRAM | 6351 | `0x8000099c` | 9 entrances; scenes  |
| `0x80809600` | just past the 8 MiB of RDRAM | 6342 | `0x8000099c` | 9 entrances; scenes  |
| `0x80809700` | just past the 8 MiB of RDRAM | 6054 | `0x8000099c` | 9 entrances; scenes  |
| `0x80809800` | just past the 8 MiB of RDRAM | 7071 | `0x8000099c` | 9 entrances; scenes  |
| `0x80809900` | just past the 8 MiB of RDRAM | 6207 | `0x8000099c` | 9 entrances; scenes  |
| `0x80809a00` | just past the 8 MiB of RDRAM | 5964 | `0x8000099c` | 9 entrances; scenes  |
| `0x80809b00` | just past the 8 MiB of RDRAM | 6696 | `0x8000099c` | 9 entrances; scenes  |
| `0x80809c00` | just past the 8 MiB of RDRAM | 6126 | `0x8000099c` | 9 entrances; scenes  |
| `0x80809d00` | just past the 8 MiB of RDRAM | 5997 | `0x8000099c` | 9 entrances; scenes  |
| `0x80809e00` | just past the 8 MiB of RDRAM | 5745 | `0x8000099c` | 9 entrances; scenes  |
| `0x80809f00` | just past the 8 MiB of RDRAM | 5655 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080a000` | just past the 8 MiB of RDRAM | 6717 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080a100` | just past the 8 MiB of RDRAM | 6294 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080a200` | just past the 8 MiB of RDRAM | 6720 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080a300` | just past the 8 MiB of RDRAM | 7029 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080a400` | just past the 8 MiB of RDRAM | 5976 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080a500` | just past the 8 MiB of RDRAM | 5931 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080a600` | just past the 8 MiB of RDRAM | 6285 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080a700` | just past the 8 MiB of RDRAM | 5625 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080a800` | just past the 8 MiB of RDRAM | 6036 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080a900` | just past the 8 MiB of RDRAM | 7329 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080aa00` | just past the 8 MiB of RDRAM | 6801 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080ab00` | just past the 8 MiB of RDRAM | 5502 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080ac00` | just past the 8 MiB of RDRAM | 6252 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080ad00` | just past the 8 MiB of RDRAM | 5751 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080ae00` | just past the 8 MiB of RDRAM | 5988 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080af00` | just past the 8 MiB of RDRAM | 5838 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080b000` | just past the 8 MiB of RDRAM | 6327 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080b100` | just past the 8 MiB of RDRAM | 5637 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080b200` | just past the 8 MiB of RDRAM | 5523 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080b300` | just past the 8 MiB of RDRAM | 5943 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080b400` | just past the 8 MiB of RDRAM | 5826 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080b500` | just past the 8 MiB of RDRAM | 5583 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080b600` | just past the 8 MiB of RDRAM | 6261 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080b700` | just past the 8 MiB of RDRAM | 7014 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080b800` | just past the 8 MiB of RDRAM | 6405 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080b900` | just past the 8 MiB of RDRAM | 5829 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080ba00` | just past the 8 MiB of RDRAM | 6183 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080bb00` | just past the 8 MiB of RDRAM | 5931 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080bc00` | just past the 8 MiB of RDRAM | 5847 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080bd00` | just past the 8 MiB of RDRAM | 6135 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080be00` | just past the 8 MiB of RDRAM | 5982 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080bf00` | just past the 8 MiB of RDRAM | 5571 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080c000` | just past the 8 MiB of RDRAM | 6300 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080c100` | just past the 8 MiB of RDRAM | 6903 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080c200` | just past the 8 MiB of RDRAM | 6033 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080c300` | just past the 8 MiB of RDRAM | 6027 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080c400` | just past the 8 MiB of RDRAM | 5871 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080c500` | just past the 8 MiB of RDRAM | 5724 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080c600` | just past the 8 MiB of RDRAM | 6504 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080c700` | just past the 8 MiB of RDRAM | 5574 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080c800` | just past the 8 MiB of RDRAM | 5928 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080c900` | just past the 8 MiB of RDRAM | 5490 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080ca00` | just past the 8 MiB of RDRAM | 6114 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080cb00` | just past the 8 MiB of RDRAM | 6693 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080cc00` | just past the 8 MiB of RDRAM | 6522 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080cd00` | just past the 8 MiB of RDRAM | 6210 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080ce00` | just past the 8 MiB of RDRAM | 5556 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080cf00` | just past the 8 MiB of RDRAM | 6852 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080d000` | just past the 8 MiB of RDRAM | 5775 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080d100` | just past the 8 MiB of RDRAM | 6042 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080d200` | just past the 8 MiB of RDRAM | 6024 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080d300` | just past the 8 MiB of RDRAM | 6063 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080d400` | just past the 8 MiB of RDRAM | 7038 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080d500` | just past the 8 MiB of RDRAM | 6075 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080d600` | just past the 8 MiB of RDRAM | 6240 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080d700` | just past the 8 MiB of RDRAM | 6207 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080d800` | just past the 8 MiB of RDRAM | 6108 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080d900` | just past the 8 MiB of RDRAM | 6651 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080da00` | just past the 8 MiB of RDRAM | 6630 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080db00` | just past the 8 MiB of RDRAM | 5853 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080dc00` | just past the 8 MiB of RDRAM | 5463 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080dd00` | just past the 8 MiB of RDRAM | 6021 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080de00` | just past the 8 MiB of RDRAM | 6159 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080df00` | just past the 8 MiB of RDRAM | 6024 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080e000` | just past the 8 MiB of RDRAM | 5784 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080e100` | just past the 8 MiB of RDRAM | 5775 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080e200` | just past the 8 MiB of RDRAM | 6600 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080e300` | just past the 8 MiB of RDRAM | 6657 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080e400` | just past the 8 MiB of RDRAM | 6315 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080e500` | just past the 8 MiB of RDRAM | 5436 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080e600` | just past the 8 MiB of RDRAM | 6120 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080e700` | just past the 8 MiB of RDRAM | 5577 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080e800` | just past the 8 MiB of RDRAM | 6114 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080e900` | just past the 8 MiB of RDRAM | 6252 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080ea00` | just past the 8 MiB of RDRAM | 6432 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080eb00` | just past the 8 MiB of RDRAM | 6018 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080ec00` | just past the 8 MiB of RDRAM | 6213 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080ed00` | just past the 8 MiB of RDRAM | 6552 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080ee00` | just past the 8 MiB of RDRAM | 6459 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080ef00` | just past the 8 MiB of RDRAM | 5793 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080f000` | just past the 8 MiB of RDRAM | 5913 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080f100` | just past the 8 MiB of RDRAM | 6321 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080f200` | just past the 8 MiB of RDRAM | 5736 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080f300` | just past the 8 MiB of RDRAM | 6093 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080f400` | just past the 8 MiB of RDRAM | 6330 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080f500` | just past the 8 MiB of RDRAM | 6798 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080f600` | just past the 8 MiB of RDRAM | 6000 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080f700` | just past the 8 MiB of RDRAM | 7503 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080f800` | just past the 8 MiB of RDRAM | 6204 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080f900` | just past the 8 MiB of RDRAM | 5532 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080fa00` | just past the 8 MiB of RDRAM | 5961 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080fb00` | just past the 8 MiB of RDRAM | 6291 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080fc00` | just past the 8 MiB of RDRAM | 5898 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080fd00` | just past the 8 MiB of RDRAM | 6105 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080fe00` | just past the 8 MiB of RDRAM | 5781 | `0x8000099c` | 9 entrances; scenes  |
| `0x8080ff00` | just past the 8 MiB of RDRAM | 5919 | `0x8000099c` | 9 entrances; scenes  |
| `0x80810000` | just past the 8 MiB of RDRAM | 5475 | `0x8000099c` | 9 entrances; scenes  |
| `0x80810100` | just past the 8 MiB of RDRAM | 6024 | `0x8000099c` | 9 entrances; scenes  |
| `0x80810200` | just past the 8 MiB of RDRAM | 6489 | `0x8000099c` | 9 entrances; scenes  |
| `0x80810300` | just past the 8 MiB of RDRAM | 6705 | `0x8000099c` | 9 entrances; scenes  |
| `0x80810400` | just past the 8 MiB of RDRAM | 6378 | `0x8000099c` | 9 entrances; scenes  |
| `0x80810500` | just past the 8 MiB of RDRAM | 5877 | `0x8000099c` | 9 entrances; scenes  |
| `0x80810600` | just past the 8 MiB of RDRAM | 6219 | `0x8000099c` | 9 entrances; scenes  |
| `0x80810700` | just past the 8 MiB of RDRAM | 5637 | `0x8000099c` | 9 entrances; scenes  |
| `0x80810800` | just past the 8 MiB of RDRAM | 5721 | `0x8000099c` | 9 entrances; scenes  |
| `0x80810900` | just past the 8 MiB of RDRAM | 6153 | `0x8000099c` | 9 entrances; scenes  |
| `0x80810a00` | just past the 8 MiB of RDRAM | 6798 | `0x8000099c` | 9 entrances; scenes  |
| `0x80810b00` | just past the 8 MiB of RDRAM | 5448 | `0x8000099c` | 9 entrances; scenes  |
| `0x80810c00` | just past the 8 MiB of RDRAM | 6435 | `0x8000099c` | 9 entrances; scenes  |
| `0x80810d00` | just past the 8 MiB of RDRAM | 5466 | `0x8000099c` | 9 entrances; scenes  |
| `0x80810e00` | just past the 8 MiB of RDRAM | 6396 | `0x8000099c` | 9 entrances; scenes  |
| `0x80810f00` | just past the 8 MiB of RDRAM | 6831 | `0x8000099c` | 9 entrances; scenes  |
| `0x80811000` | just past the 8 MiB of RDRAM | 5658 | `0x8000099c` | 9 entrances; scenes  |
| `0x80811100` | just past the 8 MiB of RDRAM | 6192 | `0x8000099c` | 9 entrances; scenes  |
| `0x80811200` | just past the 8 MiB of RDRAM | 6276 | `0x8000099c` | 9 entrances; scenes  |
| `0x80811300` | just past the 8 MiB of RDRAM | 6447 | `0x8000099c` | 9 entrances; scenes  |
| `0x80811400` | just past the 8 MiB of RDRAM | 5901 | `0x8000099c` | 9 entrances; scenes  |
| `0x80811500` | just past the 8 MiB of RDRAM | 6834 | `0x8000099c` | 9 entrances; scenes  |
| `0x80811600` | just past the 8 MiB of RDRAM | 5751 | `0x8000099c` | 9 entrances; scenes  |
| `0x80811700` | just past the 8 MiB of RDRAM | 7137 | `0x8000099c` | 9 entrances; scenes  |
| `0x80811800` | just past the 8 MiB of RDRAM | 6414 | `0x8000099c` | 9 entrances; scenes  |
| `0x80811900` | just past the 8 MiB of RDRAM | 6255 | `0x8000099c` | 9 entrances; scenes  |
| `0x80811a00` | just past the 8 MiB of RDRAM | 6471 | `0x8000099c` | 9 entrances; scenes  |
| `0x80811b00` | just past the 8 MiB of RDRAM | 5625 | `0x8000099c` | 9 entrances; scenes  |
| `0x80811c00` | just past the 8 MiB of RDRAM | 5964 | `0x8000099c` | 9 entrances; scenes  |
| `0x80811d00` | just past the 8 MiB of RDRAM | 5781 | `0x8000099c` | 9 entrances; scenes  |
| `0x80811e00` | just past the 8 MiB of RDRAM | 5799 | `0x8000099c` | 9 entrances; scenes  |
| `0x80811f00` | just past the 8 MiB of RDRAM | 5820 | `0x8000099c` | 9 entrances; scenes  |
| `0x80812000` | just past the 8 MiB of RDRAM | 6594 | `0x8000099c` | 9 entrances; scenes  |
| `0x80812100` | just past the 8 MiB of RDRAM | 6273 | `0x8000099c` | 9 entrances; scenes  |
| `0x80812200` | just past the 8 MiB of RDRAM | 6231 | `0x8000099c` | 9 entrances; scenes  |
| `0x80812300` | just past the 8 MiB of RDRAM | 6576 | `0x8000099c` | 9 entrances; scenes  |
| `0x80812400` | just past the 8 MiB of RDRAM | 5943 | `0x8000099c` | 9 entrances; scenes  |
| `0x80812500` | just past the 8 MiB of RDRAM | 6090 | `0x8000099c` | 9 entrances; scenes  |
| `0x80812600` | just past the 8 MiB of RDRAM | 6132 | `0x8000099c` | 9 entrances; scenes  |
| `0x80812700` | just past the 8 MiB of RDRAM | 6333 | `0x8000099c` | 9 entrances; scenes  |
| `0x80812800` | just past the 8 MiB of RDRAM | 5766 | `0x8000099c` | 9 entrances; scenes  |
| `0x80812900` | just past the 8 MiB of RDRAM | 5781 | `0x8000099c` | 9 entrances; scenes  |
| `0x80812a00` | just past the 8 MiB of RDRAM | 5934 | `0x8000099c` | 9 entrances; scenes  |
| `0x80812b00` | just past the 8 MiB of RDRAM | 6456 | `0x8000099c` | 9 entrances; scenes  |
| `0x80812c00` | just past the 8 MiB of RDRAM | 6633 | `0x8000099c` | 9 entrances; scenes  |
| `0x80812d00` | just past the 8 MiB of RDRAM | 5433 | `0x8000099c` | 9 entrances; scenes  |
| `0x80812e00` | just past the 8 MiB of RDRAM | 5688 | `0x8000099c` | 9 entrances; scenes  |
| `0x80812f00` | just past the 8 MiB of RDRAM | 5469 | `0x8000099c` | 9 entrances; scenes  |
| `0x80813000` | just past the 8 MiB of RDRAM | 5835 | `0x8000099c` | 9 entrances; scenes  |
| `0x80813100` | just past the 8 MiB of RDRAM | 6324 | `0x8000099c` | 9 entrances; scenes  |
| `0x80813200` | just past the 8 MiB of RDRAM | 7083 | `0x8000099c` | 9 entrances; scenes  |
| `0x80813300` | just past the 8 MiB of RDRAM | 5913 | `0x8000099c` | 9 entrances; scenes  |
| `0x80813400` | just past the 8 MiB of RDRAM | 6249 | `0x8000099c` | 9 entrances; scenes  |
| `0x80813500` | just past the 8 MiB of RDRAM | 6795 | `0x8000099c` | 9 entrances; scenes  |
| `0x80813600` | just past the 8 MiB of RDRAM | 5499 | `0x8000099c` | 9 entrances; scenes  |
| `0x80813700` | just past the 8 MiB of RDRAM | 5955 | `0x8000099c` | 9 entrances; scenes  |
| `0x80813800` | just past the 8 MiB of RDRAM | 6015 | `0x8000099c` | 9 entrances; scenes  |
| `0x80813900` | just past the 8 MiB of RDRAM | 5562 | `0x8000099c` | 9 entrances; scenes  |
| `0x80813a00` | just past the 8 MiB of RDRAM | 6468 | `0x8000099c` | 9 entrances; scenes  |
| `0x80813b00` | just past the 8 MiB of RDRAM | 7110 | `0x8000099c` | 9 entrances; scenes  |
| `0x80813c00` | just past the 8 MiB of RDRAM | 6624 | `0x8000099c` | 9 entrances; scenes  |
| `0x80813d00` | just past the 8 MiB of RDRAM | 6636 | `0x8000099c` | 9 entrances; scenes  |
| `0x80813e00` | just past the 8 MiB of RDRAM | 6174 | `0x8000099c` | 9 entrances; scenes  |
| `0x80813f00` | just past the 8 MiB of RDRAM | 5613 | `0x8000099c` | 9 entrances; scenes  |
| `0x80814000` | just past the 8 MiB of RDRAM | 5766 | `0x8000099c` | 9 entrances; scenes  |
| `0x80814100` | just past the 8 MiB of RDRAM | 5478 | `0x8000099c` | 9 entrances; scenes  |
| `0x80814200` | just past the 8 MiB of RDRAM | 6003 | `0x8000099c` | 9 entrances; scenes  |
| `0x80814300` | just past the 8 MiB of RDRAM | 6345 | `0x8000099c` | 9 entrances; scenes  |
| `0x80814400` | just past the 8 MiB of RDRAM | 6492 | `0x8000099c` | 9 entrances; scenes  |
| `0x80814500` | just past the 8 MiB of RDRAM | 7251 | `0x8000099c` | 9 entrances; scenes  |
| `0x80814600` | just past the 8 MiB of RDRAM | 6597 | `0x8000099c` | 9 entrances; scenes  |
| `0x80814700` | just past the 8 MiB of RDRAM | 5766 | `0x8000099c` | 9 entrances; scenes  |
| `0x80814800` | just past the 8 MiB of RDRAM | 5577 | `0x8000099c` | 9 entrances; scenes  |
| `0x80814900` | just past the 8 MiB of RDRAM | 5475 | `0x8000099c` | 9 entrances; scenes  |
| `0x80814a00` | just past the 8 MiB of RDRAM | 5832 | `0x8000099c` | 9 entrances; scenes  |
| `0x80814b00` | just past the 8 MiB of RDRAM | 6456 | `0x8000099c` | 9 entrances; scenes  |
| `0x80814c00` | just past the 8 MiB of RDRAM | 6015 | `0x8000099c` | 9 entrances; scenes  |
| `0x80814d00` | just past the 8 MiB of RDRAM | 6396 | `0x8000099c` | 9 entrances; scenes  |
| `0x80814e00` | just past the 8 MiB of RDRAM | 6777 | `0x8000099c` | 9 entrances; scenes  |
| `0x80814f00` | just past the 8 MiB of RDRAM | 5538 | `0x8000099c` | 9 entrances; scenes  |
| `0x80815000` | just past the 8 MiB of RDRAM | 6636 | `0x8000099c` | 9 entrances; scenes  |
| `0x80815100` | just past the 8 MiB of RDRAM | 5616 | `0x8000099c` | 9 entrances; scenes  |
| `0x80815200` | just past the 8 MiB of RDRAM | 6069 | `0x8000099c` | 9 entrances; scenes  |
| `0x80815300` | just past the 8 MiB of RDRAM | 5976 | `0x8000099c` | 9 entrances; scenes  |
| `0x80815400` | just past the 8 MiB of RDRAM | 5829 | `0x8000099c` | 9 entrances; scenes  |
| `0x80815500` | just past the 8 MiB of RDRAM | 5655 | `0x8000099c` | 9 entrances; scenes  |
| `0x80815600` | just past the 8 MiB of RDRAM | 6861 | `0x8000099c` | 9 entrances; scenes  |
| `0x80815700` | just past the 8 MiB of RDRAM | 6408 | `0x8000099c` | 9 entrances; scenes  |
| `0x80815800` | just past the 8 MiB of RDRAM | 5877 | `0x8000099c` | 9 entrances; scenes  |
| `0x80815900` | just past the 8 MiB of RDRAM | 5733 | `0x8000099c` | 9 entrances; scenes  |
| `0x80815a00` | just past the 8 MiB of RDRAM | 5802 | `0x8000099c` | 9 entrances; scenes  |
| `0x80815b00` | just past the 8 MiB of RDRAM | 6045 | `0x8000099c` | 9 entrances; scenes  |
| `0x80815c00` | just past the 8 MiB of RDRAM | 6630 | `0x8000099c` | 9 entrances; scenes  |
| `0x80815d00` | just past the 8 MiB of RDRAM | 6063 | `0x8000099c` | 9 entrances; scenes  |
| `0x80815e00` | just past the 8 MiB of RDRAM | 6225 | `0x8000099c` | 9 entrances; scenes  |
| `0x80815ecf` | just past the 8 MiB of RDRAM | 21 | `0x80081f50` | 1 entrance; scenes 107 |
| `0x80815f00` | just past the 8 MiB of RDRAM | 5997 | `0x8000099c` | 9 entrances; scenes  |
| `0x80816000` | just past the 8 MiB of RDRAM | 6030 | `0x8000099c` | 9 entrances; scenes  |
| `0x80816100` | just past the 8 MiB of RDRAM | 6717 | `0x8000099c` | 9 entrances; scenes  |
| `0x80816200` | just past the 8 MiB of RDRAM | 6321 | `0x8000099c` | 9 entrances; scenes  |
| `0x80816300` | just past the 8 MiB of RDRAM | 5925 | `0x8000099c` | 9 entrances; scenes  |
| `0x80816400` | just past the 8 MiB of RDRAM | 6120 | `0x8000099c` | 9 entrances; scenes  |
| `0x80816500` | just past the 8 MiB of RDRAM | 5580 | `0x8000099c` | 9 entrances; scenes  |
| `0x80816600` | just past the 8 MiB of RDRAM | 6606 | `0x8000099c` | 9 entrances; scenes  |
| `0x80816700` | just past the 8 MiB of RDRAM | 6021 | `0x8000099c` | 9 entrances; scenes  |
| `0x80816800` | just past the 8 MiB of RDRAM | 5550 | `0x8000099c` | 9 entrances; scenes  |
| `0x80816900` | just past the 8 MiB of RDRAM | 6594 | `0x8000099c` | 9 entrances; scenes  |
| `0x80816a00` | just past the 8 MiB of RDRAM | 6066 | `0x8000099c` | 9 entrances; scenes  |
| `0x80816b00` | just past the 8 MiB of RDRAM | 6447 | `0x8000099c` | 9 entrances; scenes  |
| `0x80816c00` | just past the 8 MiB of RDRAM | 6045 | `0x8000099c` | 9 entrances; scenes  |
| `0x80816d00` | just past the 8 MiB of RDRAM | 5793 | `0x8000099c` | 9 entrances; scenes  |
| `0x80816e00` | just past the 8 MiB of RDRAM | 6357 | `0x8000099c` | 9 entrances; scenes  |
| `0x80816f00` | just past the 8 MiB of RDRAM | 5760 | `0x8000099c` | 9 entrances; scenes  |
| `0x80817000` | just past the 8 MiB of RDRAM | 6195 | `0x8000099c` | 9 entrances; scenes  |
| `0x80817100` | just past the 8 MiB of RDRAM | 5703 | `0x8000099c` | 9 entrances; scenes  |
| `0x80817200` | just past the 8 MiB of RDRAM | 6420 | `0x8000099c` | 9 entrances; scenes  |
| `0x80817300` | just past the 8 MiB of RDRAM | 6588 | `0x8000099c` | 9 entrances; scenes  |
| `0x80817400` | just past the 8 MiB of RDRAM | 6297 | `0x8000099c` | 9 entrances; scenes  |
| `0x80817500` | just past the 8 MiB of RDRAM | 6309 | `0x8000099c` | 9 entrances; scenes  |
| `0x80817600` | just past the 8 MiB of RDRAM | 6378 | `0x8000099c` | 9 entrances; scenes  |
| `0x80817700` | just past the 8 MiB of RDRAM | 5547 | `0x8000099c` | 9 entrances; scenes  |
| `0x80817800` | just past the 8 MiB of RDRAM | 5481 | `0x8000099c` | 9 entrances; scenes  |
| `0x80817900` | just past the 8 MiB of RDRAM | 6168 | `0x8000099c` | 9 entrances; scenes  |
| `0x80817a00` | just past the 8 MiB of RDRAM | 6045 | `0x8000099c` | 9 entrances; scenes  |
| `0x80817b00` | just past the 8 MiB of RDRAM | 6051 | `0x8000099c` | 9 entrances; scenes  |
| `0x80817c00` | just past the 8 MiB of RDRAM | 6072 | `0x8000099c` | 9 entrances; scenes  |
| `0x80817d00` | just past the 8 MiB of RDRAM | 6087 | `0x8000099c` | 9 entrances; scenes  |
| `0x80817e00` | just past the 8 MiB of RDRAM | 6513 | `0x8000099c` | 9 entrances; scenes  |
| `0x80817f00` | just past the 8 MiB of RDRAM | 6933 | `0x8000099c` | 9 entrances; scenes  |
| `0x80818000` | just past the 8 MiB of RDRAM | 5649 | `0x8000099c` | 9 entrances; scenes  |
| `0x80818100` | just past the 8 MiB of RDRAM | 5880 | `0x8000099c` | 9 entrances; scenes  |
| `0x80818200` | just past the 8 MiB of RDRAM | 6126 | `0x8000099c` | 9 entrances; scenes  |
| `0x80818300` | just past the 8 MiB of RDRAM | 5991 | `0x8000099c` | 9 entrances; scenes  |
| `0x80818400` | just past the 8 MiB of RDRAM | 6558 | `0x8000099c` | 9 entrances; scenes  |
| `0x80818500` | just past the 8 MiB of RDRAM | 5589 | `0x8000099c` | 9 entrances; scenes  |
| `0x80818600` | just past the 8 MiB of RDRAM | 5553 | `0x8000099c` | 9 entrances; scenes  |
| `0x80818700` | just past the 8 MiB of RDRAM | 5892 | `0x8000099c` | 9 entrances; scenes  |
| `0x80818800` | just past the 8 MiB of RDRAM | 6708 | `0x8000099c` | 9 entrances; scenes  |
| `0x80818900` | just past the 8 MiB of RDRAM | 6600 | `0x8000099c` | 9 entrances; scenes  |
| `0x80818a00` | just past the 8 MiB of RDRAM | 6579 | `0x8000099c` | 9 entrances; scenes  |
| `0x80818b00` | just past the 8 MiB of RDRAM | 6846 | `0x8000099c` | 9 entrances; scenes  |
| `0x80818c00` | just past the 8 MiB of RDRAM | 5541 | `0x8000099c` | 9 entrances; scenes  |
| `0x80818d00` | just past the 8 MiB of RDRAM | 5517 | `0x8000099c` | 9 entrances; scenes  |
| `0x80818e00` | just past the 8 MiB of RDRAM | 5928 | `0x8000099c` | 9 entrances; scenes  |
| `0x80818f00` | just past the 8 MiB of RDRAM | 6492 | `0x8000099c` | 9 entrances; scenes  |
| `0x80819000` | just past the 8 MiB of RDRAM | 6633 | `0x8000099c` | 9 entrances; scenes  |
| `0x80819100` | just past the 8 MiB of RDRAM | 6012 | `0x8000099c` | 9 entrances; scenes  |
| `0x80819200` | just past the 8 MiB of RDRAM | 6039 | `0x8000099c` | 9 entrances; scenes  |
| `0x80819300` | just past the 8 MiB of RDRAM | 6195 | `0x8000099c` | 9 entrances; scenes  |
| `0x80819400` | just past the 8 MiB of RDRAM | 6048 | `0x8000099c` | 9 entrances; scenes  |
| `0x80819500` | just past the 8 MiB of RDRAM | 6132 | `0x8000099c` | 9 entrances; scenes  |
| `0x80819600` | just past the 8 MiB of RDRAM | 7011 | `0x8000099c` | 9 entrances; scenes  |
| `0x80819700` | just past the 8 MiB of RDRAM | 6051 | `0x8000099c` | 9 entrances; scenes  |
| `0x80819800` | just past the 8 MiB of RDRAM | 6726 | `0x8000099c` | 9 entrances; scenes  |
| `0x80819900` | just past the 8 MiB of RDRAM | 6051 | `0x8000099c` | 9 entrances; scenes  |
| `0x80819a00` | just past the 8 MiB of RDRAM | 5982 | `0x8000099c` | 9 entrances; scenes  |
| `0x80819b00` | just past the 8 MiB of RDRAM | 5445 | `0x8000099c` | 9 entrances; scenes  |
| `0x80819c00` | just past the 8 MiB of RDRAM | 5685 | `0x8000099c` | 9 entrances; scenes  |
| `0x80819d00` | just past the 8 MiB of RDRAM | 6381 | `0x8000099c` | 9 entrances; scenes  |
| `0x80819e00` | just past the 8 MiB of RDRAM | 6243 | `0x8000099c` | 9 entrances; scenes  |
| `0x80819f00` | just past the 8 MiB of RDRAM | 6030 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081a000` | just past the 8 MiB of RDRAM | 5763 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081a100` | just past the 8 MiB of RDRAM | 6612 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081a200` | just past the 8 MiB of RDRAM | 5637 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081a300` | just past the 8 MiB of RDRAM | 6294 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081a400` | just past the 8 MiB of RDRAM | 5748 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081a500` | just past the 8 MiB of RDRAM | 6468 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081a600` | just past the 8 MiB of RDRAM | 6561 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081a700` | just past the 8 MiB of RDRAM | 6234 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081a800` | just past the 8 MiB of RDRAM | 6633 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081a900` | just past the 8 MiB of RDRAM | 5796 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081aa00` | just past the 8 MiB of RDRAM | 5868 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081ab00` | just past the 8 MiB of RDRAM | 5535 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081ac00` | just past the 8 MiB of RDRAM | 6162 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081ad00` | just past the 8 MiB of RDRAM | 6132 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081ae00` | just past the 8 MiB of RDRAM | 5826 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081af00` | just past the 8 MiB of RDRAM | 5700 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081b000` | just past the 8 MiB of RDRAM | 5883 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081b100` | just past the 8 MiB of RDRAM | 6201 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081b200` | just past the 8 MiB of RDRAM | 5901 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081b300` | just past the 8 MiB of RDRAM | 5967 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081b400` | just past the 8 MiB of RDRAM | 6315 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081b500` | just past the 8 MiB of RDRAM | 6231 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081b600` | just past the 8 MiB of RDRAM | 6417 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081b700` | just past the 8 MiB of RDRAM | 6561 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081b800` | just past the 8 MiB of RDRAM | 5520 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081b900` | just past the 8 MiB of RDRAM | 5979 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081ba00` | just past the 8 MiB of RDRAM | 6354 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081bb00` | just past the 8 MiB of RDRAM | 5862 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081bc00` | just past the 8 MiB of RDRAM | 6135 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081bd00` | just past the 8 MiB of RDRAM | 6072 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081be00` | just past the 8 MiB of RDRAM | 6357 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081bf00` | just past the 8 MiB of RDRAM | 5628 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081c000` | just past the 8 MiB of RDRAM | 6027 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081c100` | just past the 8 MiB of RDRAM | 6333 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081c200` | just past the 8 MiB of RDRAM | 5814 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081c300` | just past the 8 MiB of RDRAM | 6477 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081c400` | just past the 8 MiB of RDRAM | 7152 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081c500` | just past the 8 MiB of RDRAM | 6321 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081c600` | just past the 8 MiB of RDRAM | 6249 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081c700` | just past the 8 MiB of RDRAM | 6471 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081c800` | just past the 8 MiB of RDRAM | 6108 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081c900` | just past the 8 MiB of RDRAM | 6828 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081ca00` | just past the 8 MiB of RDRAM | 6414 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081cb00` | just past the 8 MiB of RDRAM | 5646 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081cc00` | just past the 8 MiB of RDRAM | 6075 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081cd00` | just past the 8 MiB of RDRAM | 6903 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081ce00` | just past the 8 MiB of RDRAM | 5856 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081cf00` | just past the 8 MiB of RDRAM | 6381 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081d000` | just past the 8 MiB of RDRAM | 5670 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081d100` | just past the 8 MiB of RDRAM | 5874 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081d200` | just past the 8 MiB of RDRAM | 5610 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081d300` | just past the 8 MiB of RDRAM | 5502 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081d400` | just past the 8 MiB of RDRAM | 7641 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081d500` | just past the 8 MiB of RDRAM | 6126 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081d600` | just past the 8 MiB of RDRAM | 6165 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081d700` | just past the 8 MiB of RDRAM | 5838 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081d800` | just past the 8 MiB of RDRAM | 6375 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081d900` | just past the 8 MiB of RDRAM | 6243 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081da00` | just past the 8 MiB of RDRAM | 6357 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081db00` | just past the 8 MiB of RDRAM | 5892 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081dc00` | just past the 8 MiB of RDRAM | 5940 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081dd00` | just past the 8 MiB of RDRAM | 6621 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081de00` | just past the 8 MiB of RDRAM | 6375 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081df00` | just past the 8 MiB of RDRAM | 5694 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081e000` | just past the 8 MiB of RDRAM | 6054 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081e100` | just past the 8 MiB of RDRAM | 5457 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081e200` | just past the 8 MiB of RDRAM | 6702 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081e300` | just past the 8 MiB of RDRAM | 6000 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081e400` | just past the 8 MiB of RDRAM | 6318 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081e500` | just past the 8 MiB of RDRAM | 6120 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081e600` | just past the 8 MiB of RDRAM | 7614 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081e700` | just past the 8 MiB of RDRAM | 6111 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081e800` | just past the 8 MiB of RDRAM | 5472 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081e900` | just past the 8 MiB of RDRAM | 5733 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081ea00` | just past the 8 MiB of RDRAM | 6123 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081eb00` | just past the 8 MiB of RDRAM | 5760 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081ec00` | just past the 8 MiB of RDRAM | 6111 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081ed00` | just past the 8 MiB of RDRAM | 5376 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081ee00` | just past the 8 MiB of RDRAM | 5841 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081ef00` | just past the 8 MiB of RDRAM | 5841 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081f000` | just past the 8 MiB of RDRAM | 5694 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081f100` | just past the 8 MiB of RDRAM | 6834 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081f200` | just past the 8 MiB of RDRAM | 5799 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081f300` | just past the 8 MiB of RDRAM | 6096 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081f400` | just past the 8 MiB of RDRAM | 6252 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081f500` | just past the 8 MiB of RDRAM | 5895 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081f600` | just past the 8 MiB of RDRAM | 5982 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081f700` | just past the 8 MiB of RDRAM | 6054 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081f800` | just past the 8 MiB of RDRAM | 6501 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081f900` | just past the 8 MiB of RDRAM | 6093 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081fa00` | just past the 8 MiB of RDRAM | 6513 | `0x8000099c` | 9 entrances; scenes  |
| `0x8081fb00` | just past the 8 MiB of RDRAM | 6423 | `0x8000099c` | 9 entrances; scenes  |
| `0x8095e54f` | just past the 8 MiB of RDRAM | 42 | `0x80081f50` | 2 entrances; scenes 109 |
| `0x8095e58f` | just past the 8 MiB of RDRAM | 42 | `0x80081f50` | 2 entrances; scenes 107 |
| `0x80a514c8` | just past the 8 MiB of RDRAM | 8 | `0x80081dd4` | 8 entrances; scenes 7 |
| `0x80a62712` | just past the 8 MiB of RDRAM | 4 | `0x80081dd4` | 2 entrances; scenes 107 |
| `0x80b698ee` | just past the 8 MiB of RDRAM | 399824818 | `0x8002e428` | 2 entrances; scenes 109 |
| `0x80b6992e` | just past the 8 MiB of RDRAM | 399542973 | `0x8002e428` | 2 entrances; scenes 107 |
| `0x80b79930` | just past the 8 MiB of RDRAM | 2 | `0x8002bb84` | 1 entrance; scenes 107 |
| `0x80b79ef4` | just past the 8 MiB of RDRAM | 399824830 | `0x800642fc` | 2 entrances; scenes 109 |
| `0x80b79f34` | just past the 8 MiB of RDRAM | 399542985 | `0x800642fc` | 2 entrances; scenes 107 |
| `0x80ba2dbe` | just past the 8 MiB of RDRAM | 1 | `0x8002bb84` | 1 entrance; scenes 107 |
| `0x80bab5de` | just past the 8 MiB of RDRAM | 1 | `0x8002bb84` | 1 entrance; scenes 107 |
| `0x80ff000e` | just past the 8 MiB of RDRAM | 222 | `0x8002f674` | 3 entrances; scenes 31 |
| `0x8124ca81` | just past the 8 MiB of RDRAM | 2 | `0x80081dd4` | 2 entrances; scenes 109 |
| `0xc4f2002c` | other | 2 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xd100b129` | other | 2 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdb2ebdd0` | other | 844 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ebe00` | other | 1564 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ebf00` | other | 1572 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ec000` | other | 1584 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ec100` | other | 2126 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ec200` | other | 1444 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ec300` | other | 1310 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ec400` | other | 1532 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ec500` | other | 1508 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ec600` | other | 1732 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ec700` | other | 1884 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ec800` | other | 1256 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ec900` | other | 2092 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2eca00` | other | 1554 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ecb00` | other | 1452 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ecc00` | other | 1906 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ecd00` | other | 1480 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ece00` | other | 1144 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ecf00` | other | 1174 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ed000` | other | 1116 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ed100` | other | 1968 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ed200` | other | 1374 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ed300` | other | 1460 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ed400` | other | 1546 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ed500` | other | 1500 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ed600` | other | 1838 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ed700` | other | 1764 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ed800` | other | 1052 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ed900` | other | 1170 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2eda00` | other | 1480 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2edb00` | other | 1484 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2edc00` | other | 1428 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2edd00` | other | 1522 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ede00` | other | 1526 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2edf00` | other | 1744 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ee000` | other | 1810 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ee100` | other | 1448 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ee200` | other | 1558 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ee300` | other | 1846 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ee400` | other | 1718 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ee500` | other | 1434 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ee600` | other | 1358 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ee700` | other | 1816 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ee800` | other | 1814 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ee900` | other | 1594 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2eea00` | other | 1204 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2eeb00` | other | 1202 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2eec00` | other | 1934 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2eed00` | other | 1418 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2eee00` | other | 1488 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2eef00` | other | 1850 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ef000` | other | 1784 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ef100` | other | 1372 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ef200` | other | 1602 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ef300` | other | 1104 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ef400` | other | 1686 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ef500` | other | 1350 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ef600` | other | 1928 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ef700` | other | 1096 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ef800` | other | 1296 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ef900` | other | 1566 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2efa00` | other | 1576 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2efb00` | other | 1866 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2efc00` | other | 1654 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2efd00` | other | 1714 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2efe00` | other | 1106 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2eff00` | other | 1218 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f0000` | other | 1572 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f0100` | other | 1832 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f0200` | other | 1736 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f0300` | other | 1656 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f0400` | other | 1852 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f0500` | other | 1598 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f0600` | other | 1406 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f0700` | other | 1322 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f0800` | other | 1732 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f0900` | other | 1344 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f0a00` | other | 1776 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f0b00` | other | 1624 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f0c00` | other | 1216 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f0d00` | other | 1632 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f0e00` | other | 1308 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f0f00` | other | 1508 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f1000` | other | 2016 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f1100` | other | 1184 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f1200` | other | 1716 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f1300` | other | 1320 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f1400` | other | 1650 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f1500` | other | 1378 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f1600` | other | 1152 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f1700` | other | 1552 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f1800` | other | 1324 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f1900` | other | 1560 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f1a00` | other | 1322 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f1b00` | other | 1902 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f1c00` | other | 1458 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f1d00` | other | 2074 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f1e00` | other | 1160 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f1f00` | other | 1410 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f2000` | other | 1414 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f2100` | other | 1204 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f2200` | other | 1546 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f2300` | other | 1726 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f2400` | other | 2162 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f2500` | other | 1380 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f2600` | other | 1892 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f2700` | other | 1572 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f2800` | other | 1472 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f2900` | other | 1058 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f2a00` | other | 1442 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f2b00` | other | 1590 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f2c00` | other | 1664 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f2d00` | other | 1414 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f2e00` | other | 1392 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f2f00` | other | 1158 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f3000` | other | 1298 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f3100` | other | 1596 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f3200` | other | 2226 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f3300` | other | 1740 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f3400` | other | 1314 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f3500` | other | 1956 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f3600` | other | 1534 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f3700` | other | 1484 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f3800` | other | 1684 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f3900` | other | 1124 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f3a00` | other | 1884 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f3b00` | other | 1298 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f3c00` | other | 1322 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f3d00` | other | 1722 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f3e00` | other | 1632 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f3f00` | other | 1830 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f4000` | other | 1584 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f4100` | other | 1452 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f4200` | other | 1586 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f4300` | other | 1814 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f4400` | other | 1530 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f4500` | other | 1536 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f4600` | other | 1640 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f4700` | other | 1216 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f4800` | other | 1466 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f4900` | other | 1344 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f4a00` | other | 1158 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f4b00` | other | 1698 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f4c00` | other | 1656 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f4d00` | other | 1604 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f4e00` | other | 1500 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f4f00` | other | 1686 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f5000` | other | 2134 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f5100` | other | 2086 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f5200` | other | 1320 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f5300` | other | 1396 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f5400` | other | 1804 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f5500` | other | 1052 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f5600` | other | 1558 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f5700` | other | 1256 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f5800` | other | 1120 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f5900` | other | 1458 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f5a00` | other | 1636 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f5b00` | other | 2200 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f5c00` | other | 1398 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f5d00` | other | 1380 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f5e00` | other | 1726 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f5f00` | other | 1128 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f6000` | other | 1240 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f6100` | other | 1488 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f6200` | other | 1440 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f6300` | other | 1798 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f6400` | other | 1190 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f6500` | other | 1766 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f6600` | other | 1716 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f6700` | other | 1434 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f6800` | other | 1456 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f6900` | other | 1312 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f6a00` | other | 1348 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f6b00` | other | 1114 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f6c00` | other | 1306 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f6d00` | other | 1640 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f6e00` | other | 1814 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f6f00` | other | 1932 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f7000` | other | 1888 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f7100` | other | 1324 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f7200` | other | 1514 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f7300` | other | 1430 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f7400` | other | 1056 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f7500` | other | 1904 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f7600` | other | 1644 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f7700` | other | 1192 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f7800` | other | 2008 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f7900` | other | 1832 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f7a00` | other | 1626 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f7b00` | other | 1182 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f7c00` | other | 1960 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f7d00` | other | 1344 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f7e00` | other | 1518 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f7f00` | other | 1274 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f8000` | other | 1386 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f8100` | other | 1828 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f8200` | other | 1538 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f8300` | other | 1206 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f8400` | other | 1334 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f8500` | other | 1436 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f8600` | other | 1646 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f8700` | other | 1448 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f8800` | other | 1744 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f8900` | other | 1622 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f8a00` | other | 1488 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f8b00` | other | 1158 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f8c00` | other | 1388 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f8d00` | other | 1540 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f8e00` | other | 1484 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f8f00` | other | 2012 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f9000` | other | 1908 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f9100` | other | 1292 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f9200` | other | 1534 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f9300` | other | 2274 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f9400` | other | 1458 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f9500` | other | 1832 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f9600` | other | 1658 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f9700` | other | 1240 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f9800` | other | 1614 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f9900` | other | 1510 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f9a00` | other | 1402 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f9b00` | other | 1368 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f9c00` | other | 1312 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f9d00` | other | 1104 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f9e00` | other | 1272 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2f9f00` | other | 1418 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fa000` | other | 1878 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fa100` | other | 1334 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fa200` | other | 1418 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fa300` | other | 1442 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fa400` | other | 1338 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fa500` | other | 1298 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fa600` | other | 1370 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fa700` | other | 1634 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fa800` | other | 1400 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fa900` | other | 1804 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2faa00` | other | 1462 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fab00` | other | 1590 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fac00` | other | 1386 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fad00` | other | 1954 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fae00` | other | 1696 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2faf00` | other | 1394 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fb000` | other | 2110 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fb100` | other | 1314 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fb200` | other | 1100 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fb300` | other | 1448 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fb400` | other | 1586 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fb500` | other | 1666 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fb600` | other | 1634 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fb700` | other | 2158 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fb800` | other | 1154 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fb900` | other | 1134 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fba00` | other | 1220 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fbb00` | other | 1332 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fbc00` | other | 1476 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fbd00` | other | 1658 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fbe00` | other | 1432 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fbf00` | other | 1650 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fc000` | other | 1500 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fc100` | other | 1730 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fc200` | other | 1290 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fc300` | other | 1260 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fc400` | other | 1454 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fc500` | other | 2312 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fc600` | other | 1290 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fc700` | other | 1632 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fc800` | other | 1424 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fc900` | other | 1254 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fca00` | other | 1690 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fcb00` | other | 1664 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fcc00` | other | 1666 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fcd00` | other | 1764 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fce00` | other | 1204 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fcf00` | other | 1870 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fd000` | other | 1288 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fd100` | other | 1830 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fd200` | other | 1642 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fd300` | other | 1764 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fd400` | other | 1562 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fd500` | other | 1544 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fd600` | other | 1512 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fd700` | other | 1598 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fd800` | other | 1500 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fd900` | other | 1694 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fda00` | other | 1404 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fdb00` | other | 1210 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fdc00` | other | 1534 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fdd00` | other | 1428 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fde00` | other | 1394 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fdf00` | other | 1598 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fe000` | other | 1380 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fe100` | other | 1538 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fe200` | other | 1746 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fe300` | other | 1630 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fe400` | other | 1350 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fe500` | other | 1678 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fe600` | other | 1462 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fe700` | other | 1240 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fe800` | other | 1800 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fe900` | other | 1768 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fea00` | other | 1260 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2feb00` | other | 1502 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fec00` | other | 1856 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fed00` | other | 1246 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fee00` | other | 2038 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2fef00` | other | 1590 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ff000` | other | 1586 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ff100` | other | 1752 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ff200` | other | 1422 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ff300` | other | 1418 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ff400` | other | 1526 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ff500` | other | 1632 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ff600` | other | 1934 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ff700` | other | 1846 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ff800` | other | 1492 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ff900` | other | 1916 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ffa00` | other | 1584 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ffb00` | other | 1318 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ffc00` | other | 1280 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ffd00` | other | 1226 | `0x8000099c` | 2 entrances; scenes  |
| `0xdb2ffe00` | other | 1288 | `0x800a0a30` | 2 entrances; scenes  |
| `0xdb2fff00` | other | 1820 | `0x800a0a30` | 2 entrances; scenes  |
| `0xdb300000` | other | 1432 | `0x800a0a30` | 2 entrances; scenes  |
| `0xdb300100` | other | 1288 | `0x800a0a30` | 2 entrances; scenes  |
| `0xdb300200` | other | 1380 | `0x800a0a30` | 2 entrances; scenes  |
| `0xdb300300` | other | 1110 | `0x800a0a30` | 2 entrances; scenes  |
| `0xdb300400` | other | 1636 | `0x800a0a30` | 2 entrances; scenes  |
| `0xdb300500` | other | 1386 | `0x800a0a30` | 2 entrances; scenes  |
| `0xdb300600` | other | 1352 | `0x800a0a30` | 2 entrances; scenes  |
| `0xdb300700` | other | 1632 | `0x800a0a30` | 2 entrances; scenes  |
| `0xdb300800` | other | 1264 | `0x800a0a30` | 2 entrances; scenes  |
| `0xdb300900` | other | 1472 | `0x800a0a30` | 2 entrances; scenes  |
| `0xdb300a00` | other | 1120 | `0x800a0a30` | 2 entrances; scenes  |
| `0xdb300b00` | other | 1548 | `0x800a0a30` | 2 entrances; scenes  |
| `0xdb300c00` | other | 1422 | `0x800a0a30` | 2 entrances; scenes  |
| `0xdb300d00` | other | 1540 | `0x800a0a30` | 2 entrances; scenes  |
| `0xdb300e00` | other | 2562 | `0x800a0a30` | 2 entrances; scenes  |
| `0xdb300f00` | other | 1896 | `0x800a0a30` | 2 entrances; scenes  |
| `0xdb301000` | other | 1686 | `0x800a0a30` | 2 entrances; scenes  |
| `0xdb301100` | other | 1454 | `0x800a0a30` | 2 entrances; scenes  |
| `0xdb301200` | other | 1462 | `0x800a0a30` | 2 entrances; scenes  |
| `0xdb301300` | other | 1148 | `0x800a0a30` | 2 entrances; scenes  |
| `0xdb301400` | other | 1690 | `0x800a0a30` | 2 entrances; scenes  |
| `0xdb301500` | other | 1534 | `0x800a0a30` | 2 entrances; scenes  |
| `0xdb301600` | other | 1430 | `0x800a0a30` | 2 entrances; scenes  |
| `0xdb301700` | other | 1542 | `0x800a0a30` | 2 entrances; scenes  |
| `0xdb301800` | other | 1478 | `0x800a0a30` | 2 entrances; scenes  |
| `0xdb301900` | other | 1282 | `0x800a0a30` | 2 entrances; scenes  |
| `0xdb301a00` | other | 1586 | `0x800a0a30` | 2 entrances; scenes  |
| `0xdb301b00` | other | 1416 | `0x800a0a30` | 2 entrances; scenes  |
| `0xdb301c00` | other | 1674 | `0x800a0a30` | 2 entrances; scenes  |
| `0xdb301d00` | other | 1642 | `0x800a0a30` | 2 entrances; scenes  |
| `0xdb301e00` | other | 1728 | `0x800a27c4` | 2 entrances; scenes  |
| `0xdb301f00` | other | 1414 | `0x800a27c4` | 2 entrances; scenes  |
| `0xdb302000` | other | 1588 | `0x800a27c4` | 2 entrances; scenes  |
| `0xdb302100` | other | 1238 | `0x800a27c4` | 2 entrances; scenes  |
| `0xdb302200` | other | 1452 | `0x800a27c4` | 2 entrances; scenes  |
| `0xdb302300` | other | 1560 | `0x800a27c4` | 2 entrances; scenes  |
| `0xdb302400` | other | 1728 | `0x800a27c4` | 2 entrances; scenes  |
| `0xdb302500` | other | 1596 | `0x800a27c4` | 2 entrances; scenes  |
| `0xdb302600` | other | 1654 | `0x800a27c4` | 2 entrances; scenes  |
| `0xdb302700` | other | 1632 | `0x800a27c4` | 2 entrances; scenes  |
| `0xdb302800` | other | 1416 | `0x800a27c4` | 2 entrances; scenes  |
| `0xdb302900` | other | 1090 | `0x800a27c4` | 2 entrances; scenes  |
| `0xdb302a00` | other | 2154 | `0x800a27c4` | 2 entrances; scenes  |
| `0xdb302b00` | other | 1052 | `0x800a27c4` | 2 entrances; scenes  |
| `0xdb302c00` | other | 1348 | `0x800a27c4` | 2 entrances; scenes  |
| `0xdb302d00` | other | 1228 | `0x800a27c4` | 2 entrances; scenes  |
| `0xdb302e00` | other | 1910 | `0x800a27c4` | 2 entrances; scenes  |
| `0xdb302f00` | other | 1488 | `0x800a27c4` | 2 entrances; scenes  |
| `0xdb303000` | other | 2170 | `0x800a27c4` | 2 entrances; scenes  |
| `0xdb303100` | other | 1464 | `0x800a27c4` | 2 entrances; scenes  |
| `0xdb303200` | other | 1076 | `0x800a27c4` | 2 entrances; scenes  |
| `0xdb303300` | other | 1390 | `0x800a27c4` | 2 entrances; scenes  |
| `0xdb303400` | other | 1776 | `0x800a27c4` | 2 entrances; scenes  |
| `0xdb303500` | other | 2002 | `0x800a27c4` | 2 entrances; scenes  |
| `0xdb303600` | other | 1478 | `0x800a27c4` | 2 entrances; scenes  |
| `0xdb303700` | other | 2014 | `0x800a27c4` | 2 entrances; scenes  |
| `0xdb303800` | other | 1208 | `0x800a27c4` | 2 entrances; scenes  |
| `0xdb303900` | other | 1516 | `0x800a27c4` | 2 entrances; scenes  |
| `0xdb303a00` | other | 1052 | `0x800a27c4` | 2 entrances; scenes  |
| `0xdb303b00` | other | 1082 | `0x800a27c4` | 2 entrances; scenes  |
| `0xdb303c00` | other | 1284 | `0x800a27c4` | 2 entrances; scenes  |
| `0xdb303d00` | other | 2072 | `0x800a27c4` | 2 entrances; scenes  |
| `0xdb303e00` | other | 2010 | `0x800a2770` | 2 entrances; scenes  |
| `0xdb303f00` | other | 1412 | `0x800a2770` | 2 entrances; scenes  |
| `0xdb304000` | other | 1232 | `0x800a2770` | 2 entrances; scenes  |
| `0xdb304100` | other | 1674 | `0x800a2770` | 2 entrances; scenes  |
| `0xdb304200` | other | 1962 | `0x800a2770` | 2 entrances; scenes  |
| `0xdb304300` | other | 1284 | `0x800a2770` | 2 entrances; scenes  |
| `0xdb304400` | other | 1344 | `0x800a2770` | 2 entrances; scenes  |
| `0xdb304500` | other | 1126 | `0x800a2770` | 2 entrances; scenes  |
| `0xdb304600` | other | 1358 | `0x800a2770` | 2 entrances; scenes  |
| `0xdb304700` | other | 1160 | `0x800a2770` | 2 entrances; scenes  |
| `0xdb304800` | other | 1486 | `0x800a2770` | 2 entrances; scenes  |
| `0xdb304900` | other | 1394 | `0x800a2770` | 2 entrances; scenes  |
| `0xdb304a00` | other | 2122 | `0x800a2770` | 2 entrances; scenes  |
| `0xdb304b00` | other | 1846 | `0x800a2770` | 2 entrances; scenes  |
| `0xdb304c00` | other | 1164 | `0x800a2770` | 2 entrances; scenes  |
| `0xdb304d00` | other | 1904 | `0x800a2770` | 2 entrances; scenes  |
| `0xdb304e00` | other | 1666 | `0x800a2770` | 2 entrances; scenes  |
| `0xdb304f00` | other | 1224 | `0x800a2770` | 2 entrances; scenes  |
| `0xdb305000` | other | 1492 | `0x800a2770` | 2 entrances; scenes  |
| `0xdb305100` | other | 2088 | `0x800a2770` | 2 entrances; scenes  |
| `0xdb305200` | other | 1840 | `0x800a2770` | 2 entrances; scenes  |
| `0xdb305300` | other | 1160 | `0x800a2770` | 2 entrances; scenes  |
| `0xdb305400` | other | 1210 | `0x800a2770` | 2 entrances; scenes  |
| `0xdb305500` | other | 1400 | `0x800a2770` | 2 entrances; scenes  |
| `0xdb305600` | other | 2264 | `0x800a2770` | 2 entrances; scenes  |
| `0xdb305700` | other | 1690 | `0x800a2770` | 2 entrances; scenes  |
| `0xdb305800` | other | 1630 | `0x800a2770` | 2 entrances; scenes  |
| `0xdb305900` | other | 1078 | `0x800a2770` | 2 entrances; scenes  |
| `0xdb305a00` | other | 1146 | `0x800a2770` | 2 entrances; scenes  |
| `0xdb305b00` | other | 1386 | `0x800a2770` | 2 entrances; scenes  |
| `0xdb305c00` | other | 1450 | `0x800a2770` | 2 entrances; scenes  |
| `0xdb305d00` | other | 1348 | `0x800a2770` | 2 entrances; scenes  |
| `0xdb305e00` | other | 1260 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb305f00` | other | 1720 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb306000` | other | 2050 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb306100` | other | 1378 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb306200` | other | 1822 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb306300` | other | 1678 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb306400` | other | 1304 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb306500` | other | 1502 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb306600` | other | 1390 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb306700` | other | 1354 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb306800` | other | 1386 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb306900` | other | 1370 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb306a00` | other | 1338 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb306b00` | other | 1430 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb306c00` | other | 1708 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb306d00` | other | 1410 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb306e00` | other | 1748 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb306f00` | other | 1312 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb307000` | other | 1954 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb307100` | other | 1744 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb307200` | other | 1530 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb307300` | other | 1294 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb307400` | other | 1780 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb307500` | other | 1044 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb307600` | other | 1596 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb307700` | other | 1224 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb307800` | other | 1628 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb307900` | other | 1470 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb307a00` | other | 1582 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb307b00` | other | 1528 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb307c00` | other | 1770 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb307d00` | other | 1404 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb307e00` | other | 1574 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb307f00` | other | 1914 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb308000` | other | 1470 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb308100` | other | 1332 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb308200` | other | 1466 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb308300` | other | 1350 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb308400` | other | 1288 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb308500` | other | 1660 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb308600` | other | 2470 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb308700` | other | 1636 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb308800` | other | 1750 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb308900` | other | 1420 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb308a00` | other | 1432 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb308b00` | other | 1618 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb308c00` | other | 1642 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb308d00` | other | 1396 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb308e00` | other | 1576 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb308f00` | other | 1764 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb309000` | other | 1610 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb309100` | other | 1914 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb309200` | other | 1258 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb309300` | other | 1324 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb309400` | other | 1548 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb309500` | other | 1344 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb309600` | other | 1138 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb309700` | other | 1322 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb309800` | other | 1846 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb309900` | other | 1312 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb309a00` | other | 1372 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb309b00` | other | 1472 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb309c00` | other | 1928 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb309d00` | other | 1486 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb309e00` | other | 1482 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb309f00` | other | 1844 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb30a000` | other | 1764 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb30a100` | other | 1546 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb30a200` | other | 1518 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb30a300` | other | 1206 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb30a400` | other | 1794 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb30a500` | other | 1276 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb30a600` | other | 1358 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb30a700` | other | 1384 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb30a800` | other | 1952 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb30a900` | other | 1384 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb30aa00` | other | 1650 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb30ab00` | other | 1204 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb30ac00` | other | 1624 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb30ad00` | other | 1338 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb30ae00` | other | 1620 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb30af00` | other | 1838 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb30b000` | other | 1270 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb30b100` | other | 1580 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb30b200` | other | 1410 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb30b300` | other | 1270 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb30b400` | other | 1604 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb30b500` | other | 1914 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb30b600` | other | 1384 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb30b700` | other | 1460 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdb30b800` | other | 1400 | `0x800a34b4` | 2 entrances; scenes  |
| `0xdcfd0408` | other | 6 | `0x800a34b4` | 6 entrances; scenes 93 |
| `0xdfff6f0f` | other | 2360 | `0x8000122c` | 2 entrances; scenes 106 |
| `0xdfff7000` | other | 1506 | `0x8000122c` | 2 entrances; scenes 106 |
| `0xdfff7100` | other | 1454 | `0x8000122c` | 2 entrances; scenes 106 |
| `0xdfff7200` | other | 1036 | `0x8000122c` | 2 entrances; scenes 106 |
| `0xdfff7300` | other | 654 | `0x8000122c` | 2 entrances; scenes 106 |
| `0xdfff7400` | other | 824 | `0x8000122c` | 2 entrances; scenes 106 |
| `0xdfff7500` | other | 1056 | `0x8000122c` | 2 entrances; scenes 106 |
| `0xdfff7600` | other | 2174 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff7700` | other | 1678 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff7800` | other | 1180 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff7900` | other | 1012 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff7a00` | other | 930 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff7b00` | other | 686 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff7c00` | other | 842 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff7d00` | other | 822 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff7e00` | other | 1040 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff7f00` | other | 556 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff8000` | other | 894 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff8100` | other | 804 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff8200` | other | 702 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff8300` | other | 998 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff8400` | other | 644 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff8500` | other | 834 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff8600` | other | 1098 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff8700` | other | 1066 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff8800` | other | 802 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff8900` | other | 740 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff8a00` | other | 1008 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff8b00` | other | 660 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff8c00` | other | 954 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff8d00` | other | 1022 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff8e00` | other | 1512 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff8f00` | other | 1072 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff9000` | other | 758 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff9100` | other | 1040 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff9200` | other | 896 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff9300` | other | 764 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff9400` | other | 680 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff9500` | other | 926 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff9600` | other | 706 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff9700` | other | 1002 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff9800` | other | 814 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff9900` | other | 656 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff9a00` | other | 766 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff9b00` | other | 688 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff9c00` | other | 706 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff9d00` | other | 708 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff9e00` | other | 1986 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfff9f00` | other | 1490 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffa000` | other | 750 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffa100` | other | 702 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffa200` | other | 544 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffa300` | other | 564 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffa400` | other | 626 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffa500` | other | 722 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffa600` | other | 1538 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffa700` | other | 1304 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffa800` | other | 526 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffa900` | other | 836 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffaa00` | other | 824 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffab00` | other | 842 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffac00` | other | 694 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffad00` | other | 1032 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffae00` | other | 818 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffaf00` | other | 588 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffb000` | other | 704 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffb100` | other | 808 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffb200` | other | 856 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffb300` | other | 780 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffb400` | other | 640 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffb500` | other | 630 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffb600` | other | 512 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffb700` | other | 578 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffb800` | other | 866 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffb900` | other | 672 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffba00` | other | 546 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffbb00` | other | 1924 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffbc00` | other | 572 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffbd00` | other | 598 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffbe00` | other | 674 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffbf00` | other | 1020 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffc000` | other | 754 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffc100` | other | 648 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffc200` | other | 512 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffc300` | other | 518 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffc400` | other | 512 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffc500` | other | 512 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffc600` | other | 996 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffc700` | other | 812 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffc800` | other | 738 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffc900` | other | 954 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffca00` | other | 552 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffcb00` | other | 1238 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffcc00` | other | 830 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffcd00` | other | 682 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffce00` | other | 756 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffcf00` | other | 782 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffd000` | other | 868 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffd100` | other | 862 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffd200` | other | 790 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffd300` | other | 1078 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffd400` | other | 564 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffd500` | other | 590 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffd600` | other | 548 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffd700` | other | 668 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffd800` | other | 602 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffd900` | other | 688 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffda00` | other | 958 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffdb00` | other | 854 | `0x800a0a30` | 2 entrances; scenes 106 |
| `0xdfffdc00` | other | 620 | `0x800a0a30` | 2 entrances; scenes 106 |
| `0xdfffdd00` | other | 1216 | `0x800a0a30` | 2 entrances; scenes 106 |
| `0xdfffde00` | other | 896 | `0x800a0a30` | 2 entrances; scenes 106 |
| `0xdfffdf00` | other | 586 | `0x800a0a30` | 2 entrances; scenes 106 |
| `0xdfffe000` | other | 666 | `0x800a0a30` | 2 entrances; scenes 106 |
| `0xdfffe100` | other | 1082 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffe200` | other | 638 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffe300` | other | 924 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffe400` | other | 676 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffe500` | other | 682 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffe600` | other | 936 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffe700` | other | 962 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffe800` | other | 766 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffe900` | other | 682 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffea00` | other | 652 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffeb00` | other | 636 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffec00` | other | 626 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffed00` | other | 590 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffee00` | other | 1140 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffef00` | other | 1624 | `0x800a27c4` | 2 entrances; scenes 106 |
| `0xdffff000` | other | 1216 | `0x800a27c4` | 2 entrances; scenes 106 |
| `0xdffff100` | other | 964 | `0x800a27c4` | 2 entrances; scenes 106 |
| `0xdffff200` | other | 830 | `0x800a27c4` | 2 entrances; scenes 106 |
| `0xdffff300` | other | 854 | `0x800a27c4` | 2 entrances; scenes 106 |
| `0xdffff400` | other | 816 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdffff500` | other | 690 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdffff600` | other | 716 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdffff700` | other | 686 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdffff800` | other | 644 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdffff900` | other | 574 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdffffa00` | other | 606 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdffffb00` | other | 556 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdffffc00` | other | 574 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdffffd00` | other | 786 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdffffe00` | other | 700 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xdfffff00` | other | 684 | `0x8000099c` | 2 entrances; scenes 106 |
| `0xfbd2fb6c` | other | 2 | `0x80081dd4` | 1 entrance; scenes 107 |
| `0xffed0004` | other | 18 | `0x800a34b4` | 6 entrances; scenes 93 |
<!-- scenes:end -->

## Rendering bugs of the forest task that are not solved (moved to the playable-forest task)

Fixed in m4-3d: the black ladder and the path that comes and goes (one browser bug, `docs/re/display-lists.md` section 10), plus the microcode formulas of section 9. Left:

1. **The background that blinks dark blue.** Not reproduced. Checked: (a) display lists only: 14,000 frames of the idle title and attract demo (a throwaway scan, not kept, of what the last task drawn into the picture shown at each retrace contained: triangles, rectangles and fills): the only shown frames without a scene are 257-262, a black gap between the logo and the title (fill colour `0x00010001`, the screen is cleared, no dark blue); every fill in the demo is that black or the depth clear `0xFFFCFFFC`, so "dark blue" cannot be a clear colour. (b) The real page code (`web/game.ts`, `web/renderer.ts`, headless Chrome with SwiftShader, one game frame per present and also the bursts of the main loop, at scale 1 and 3), 26,000 frames, a thumbnail of every presented frame: no frame differs from both neighbours while they agree with each other (the dark-blue stretches are the night shots, frames 341-553, 5534-5539 (a flash fade) and 6388-6600). (c) 60 frames spread over the demo drawn by WebGL and by the software renderer: 100 pixels or fewer differ. (d) The renderer's texture cache is emptied every 512 textures (once per 11,000 frames of the demo): before this task that could delete a texture a draw held; made safe, with no visible effect found. Hypotheses left: a GPU-dependent shader result on real hardware (`wrapCoord`, `texelFetch`), or the user's saved game changing what the demo does. Next step: the frame number of the blink from the `#debug` overlay on the user's machine, then capture the display lists of that range and draw them in the page and in the software renderer as was done here.
2. **The bridge of the Sheik/Link shot.** Not located. In the castle sequence of the intro (frames 5200-6300 of the headless run) the dl interpreter's triangles cover the same pixels as the microcode's (0.5% at most, 133 tasks compared); so the missing part, if it is in that sequence, is a draw that covers pixels and writes none (texture, alpha, depth or blend), or geometry the game never submits. The scan of batches that write nothing when drawn alone found five kinds of batch in 1,200 frames (opaque `127E03/FFFFFDF8` texture 64x16 and similar), none yet shown to be a bridge. Next step: the frame number of the shot, then draw its batches one by one and compare with footage; if the geometry is absent from the lists, look for an actor or object that fails to load.

## Draw calls and final per-phase times

`web/renderer.ts` now turns a task into runs (`web/batching.ts`): consecutive batches with the same program, uniforms, textures, scissor, viewport and colour image are one `drawArrays`, a fill rectangle or any state change ends a run, and the order of the batches is kept. A task's vertices go to the GPU in one `bufferData` instead of one per batch, and GPU textures are keyed by the interpreter's image id, so they live across tasks and no pixel is hashed (the id is never reused, so equal ids mean equal pixels).

Measured on 20 game frames of Kokiri Forest (entrance 238, video frames 21,340-21,400 of the scripted new game), the recorded display lists drawn in Chrome 155 (headless, SwiftShader, WebGL2) by the old renderer and the new one on the same input:

| | Old | New |
|---|---|---|
| Batches per task | 112 | 112 |
| Draw calls per task | 110.0 | 99.8 |
| Pixels differing between the two renderers | – | 0 in all 20 frames (the images are identical) |
| Pixels differing from the software rasteriser (more than 6 per channel) | 614 at most per frame (0.8%) | the same 614 at most, frame by frame |

- The gain is small, about 9%: between two consecutive batches the texture changes in nearly every pair (so does the tile placement), and the primitive colour or render mode in many. Only batches that differ in nothing the draw can see merge (12 of 112 pairs). Merging more needs textures in an atlas or a per-vertex texture index: a different design, not done here.
- **Time:** not measurable here. The only GL available is SwiftShader (software), where the draw call itself rasterises: 25-40 ms per task in both versions, runs differing by more than the two versions do from each other, and no `EXT_disjoint_timer_query_webgl2`. On a real GPU the submit cost of 100 draw calls is well under 1 ms, so the changes were kept because they are correct and cheaper in calls, buffer uploads and hashing, not because a gain was shown. The debug overlay shows the real submit and GPU times on the user's machine.
- The harness was throwaway (not kept): the C interpreter's results for the frames were saved as JSON, then drawn by both renderers and the software rasteriser in one page and compared pixel by pixel.

Final per-phase times next to the first measurement (milliseconds per game frame, Kokiri Forest):

| Phase | First measurement (TypeScript interpreter) | Now (C interpreter, merged draws) |
|---|---|---|
| Game code | 0.69-0.73 (headless) | 0.67-0.98 (headless) |
| Display lists | 5.04-5.17 (headless) | 0.78-0.91 (headless, result read as the page reads it) |
| WebGL submit | not measured (needs a browser) | not measurable here (SwiftShader only); see above |
| GPU | not measured (needs a browser) | not measurable here (no timer query) |
| Draw calls per frame | 113.5 | 99.8 (from 110.0 unmerged on the 20 frames above) |
