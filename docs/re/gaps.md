# Gaps: what the runtime does not handle yet

Result of the gap sweep: what the game can ask of the runtime (read from the binary), and what it did ask over every entrance of its entrance table (measured). Everything below cites addresses of this ROM. The two big tables at the end are generated (`npm run sweep -- report`) and rewritten between their marker comments.

Reproduce:

```
npm run port -- --coverage --dist dist-cov --generated generated   # coverage build, see "Coverage mode"
npm run sweep -- static                                            # ROM + out/inventory.json -> out/sweep/static.json
npm run sweep -- scenes --dump out/sweep/frames [--shard k/n]      # every entrance, 300 frames each (--entrances 697 for one)
npm run sweep -- report                                            # rewrites the generated blocks of this file
```

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
- **Mip levels and anisotropy** (`mipmaps`, `anisotropy`, key H): in the shader, since the wrap and mirror rules need `texelFetch`. The level comes from the screen derivatives of the texel coordinate; taps (at most `anisotropy`, 4 on desktop, 2 on a coarse pointer) are spread along the long side of the footprint, each filtered with the chosen filter at two levels and blended. Only triangle draws, and only a tile whose mask is zero or equals the texture size (a smaller mask repeats part of a texture, and a level of the whole texture would blend the repeat with its neighbours). Rectangles, the HUD and copy mode never use mip levels. Nothing changes where a texel is magnified.
- **MSAA x4** (`msaa`, key G): the colour images and the depth buffer are multisampled renderbuffers, resolved into the textures the video interface presents at the end of each task; 0 samples when the browser offers none.
- **Settings** are stored as JSON in `localStorage['oot.gfx']` (`filter`, `msaa`, `scaleCap`, `mipmaps`, `anisotropy`); a missing, unreadable or invalid field takes its default. The overlay shows the 3D size, filter, samples and shader build time.

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

Two sliders next to the toggle tune it (stored in localStorage, `SmoothTuning`): **strength** (0 to 100%, default 100) keeps the picture nearer the current frame, 0 showing the game's own frames only; **catch-up** (25 to 100%, default 100) is the share of a game-frame interval the motion takes to reach the current frame, so 50% halves the added delay and holds the current frame for the rest.

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
| `02` |  | `0x1c74` | missing | the handler address holds only zero words in the text image the task points at (the routine is not in it); the interpreter does not model the opcode |
| `03` | CULLDL | `0x1c34` | implemented | microcode routine |
| `04` |  | `0x1c5c` | missing | the handler address holds only zero words in the text image the task points at (the routine is not in it); the interpreter does not model the opcode |
| `05` | TRI1 | `0x17b4` | implemented | microcode routine |
| `06` | TRI2 | `0x17ac` | implemented | microcode routine |
| `07` | QUAD | `0x17ac` | implemented | microcode routine |
| `08` |  | `0x118c` | missing | the microcode has a routine for it; the interpreter does not |
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
| `dd` |  | `0x1fac` | missing | the microcode has a routine for it; the interpreter does not |
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
- `02` at `0x1c74`: `nop; nop; nop; nop`
- `04` at `0x1c5c`: `nop; nop; nop; nop`
- `08` at `0x118c`: `sw $t9, 0($s7); j 0x250; addi $s7, $s7, 8; addi $ra, $zero, 4616`
- `d0` at `0x1188`: `sw $t8, 4($s7); sw $t9, 0($s7); j 0x250; addi $s7, $s7, 8`
- `d1` at `0x1078`: `mfc0 $t3, c0r11; andi $t3, $t3, 0x400; bne $t3, $zero, 0x78; addi $t3, $zero, 1`
- `d2` at `0x1188`: `sw $t8, 4($s7); sw $t9, 0($s7); j 0x250; addi $s7, $s7, 8`
- `d3` at `0x118c`: `sw $t9, 0($s7); j 0x250; addi $s7, $s7, 8; addi $ra, $zero, 4616`
- `d4` at `0x118c`: `sw $t9, 0($s7); j 0x250; addi $s7, $s7, 8; addi $ra, $zero, 4616`
- `d5` at `0x118c`: `sw $t9, 0($s7); j 0x250; addi $s7, $s7, 8; addi $ra, $zero, 4616`
- `d6` at `0x11b8`: `sw $t9, 200($zero); j 0x208; sw $t8, 204($zero); sw $t9, 192($zero)`
- `dd` at `0x1fac`: `sw $k0, 4080($zero); sw $t8, 4048($zero); addiu $s4, $zero, 4224; jal 0xfd8`
- `e0` at `0x118c`: `sw $t9, 0($s7); j 0x250; addi $s7, $s7, 8; addi $ra, $zero, 4616`
- `e5` at `0x102c`: `andi $t4, $t4, 0x1; beq $t4, $zero, 0xac; sw $zero, 4036($zero); j 0x164`
- `ea` at `0x1208`: `bne $t3, $zero, 0x200; lw $t8, 4072($zero); mfc0 $t3, c0r10; beq $t3, $t8, 0x210`
- `eb` at `0x1208`: `bne $t3, $zero, 0x200; lw $t8, 4072($zero); mfc0 $t3, c0r10; beq $t3, $t8, 0x210`
- `ec` at `0x1208`: `bne $t3, $zero, 0x200; lw $t8, 4072($zero); mfc0 $t3, c0r10; beq $t3, $t8, 0x210`
- `ee` at `0x1208`: `bne $t3, $zero, 0x200; lw $t8, 4072($zero); mfc0 $t3, c0r10; beq $t3, $t8, 0x210`

Of 256 opcode values: 18 missing, 39 implemented, 199 unsupported-by-design (the last are the values outside the table).

### Audio microcode opcodes

Microcode text 0x800e0f10, data 0x801120e0. dispatch at microcode offset 0x60: srl at,k0,23; andi at,at,0xfe; lh v0,16(v0); jr v0 (halfword table at data offset 0x10, indexed by the opcode byte).

| Op | Name | Handler | Status | Why |
|---|---|---|---|---|
| `00` |  | `0x1f68` | missing | the microcode has a handler; the mixer rejects the command |
| `01` | ADPCM decode | `0x1230` | implemented | handled by the mixer |
| `02` | clear | `0x114c` | implemented | handled by the mixer |
| `03` |  | `0x1f18` | missing | the microcode has a handler; the mixer rejects the command |
| `04` |  | `0x1e2c` | missing | the microcode has a handler; the mixer rejects the command |
| `05` | resample | `0x14f4` | implemented | handled by the mixer |
| `06` |  | `0x1e9c` | missing | the microcode has a handler; the mixer rejects the command |
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
| `17` |  | `0x1ba0` | missing | the microcode has a handler; the mixer rejects the command |

First instructions of the handlers the runtime lacks:

- `00` at `0x1f68`: `jal 0xa6c; nop; addi $at, $s7, 0; jal 0xad4`
- `03` at `0x1f18`: `lqv $v31[0], 0($zero); andi $s2, $k0, 0xffff; andi $s3, $t9, 0xffff; srl $s4, $t9, 16`
- `04` at `0x1e2c`: `vaddc $v31, $v31, $v31[e=0]; srl $s2, $k0, 12; andi $s2, $s2, 0xff0; andi $s3, $t9, 0xffff`
- `06` at `0x1e9c`: `lh $t6, 0($t8); lh $t7, 2($t8); lh $t5, 4($t8); andi $t4, $k0, 0xffff`
- `17` at `0x1ba0`: `lhu $t5, 0($t8); vxor $v2, $v2, $v2[e=0]; lhu $t6, 2($t8); vxor $v3, $v3, $v3[e=0]`

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
Sweep of 1556 entrances (1519 run, 37 skipped as invalid), 300 video frames each, from the game under control at frame 19000; 52 game instance(s) started (1 + recoveries).

Status: 1483 ok, 37 invalid-scene, 22 not-reached, 14 trap. Blank: 1507 no, 12 no-geometry.

Traps and hangs (a game that loops past 200 million iterations in one frame is stopped by the watchdog of the coverage build):

| Message | Hits | Entrances |
|---|---|---|
| watchdog: over 200000000 loop iterations in one video frame, at the loop 0x8002f824 (last function entered: 0x8002f6dc) | 4 entrances; scenes 7 | 694–697 |
| PI access to unmapped cartridge address 0x0096e03c | 4 entrances; scenes 6 | 1016–1019 |
| watchdog: over 200000000 loop iterations in one video frame, at the loop 0x80004fc8 (last function entered: 0x80004f70) | 6 entrances; scenes  | 1410–1411, 1552–1555 |

Unknown display-list commands (a `*` marks commands that follow an opcode 0xdd in the same list):

| Opcode | Hits | First command seen |
|---|---|---|
| `02*` | 16 entrances; scenes 1, 13, 38, 44 | entrance 183: `02140000 003700ce at 0x328388` |
| `02` | 78 entrances; scenes 8, 12, 19, 42, 54, 62, 64, 66, 71, 76, 81, 82, 87 | entrance 59: `02140000 003700ce at 0x311bf8` |
| `04` | 232 entrances; scenes 0, 7, 12, 13, 14, 26, 32, 33, 34, 60, 61, 72, 75, 82, 83, 84, 85, 88, 90, 92, 93, 94, 95, 96, 97, 98, 99, 100 | entrance 220: `04000000 000003e8 at 0x23ec00` |
| `0a*` | 234 entrances; scenes 0, 1, 2, 6, 9, 11, 12, 13, 18, 20, 27, 28, 29, 30, 31, 35, 36, 37, 38, 39, 41, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 55, 56, 57, 58, 62, 63, 67, 69, 74, 81, 85, 86, 89, 90, 93, 97, 98 | entrance 0: `0a000000 8017ac10 at 0x17ac48` |
| `dd` | 234 entrances; scenes 0, 1, 2, 6, 9, 11, 12, 13, 18, 20, 27, 28, 29, 30, 31, 35, 36, 37, 38, 39, 41, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 55, 56, 57, 58, 62, 63, 67, 69, 74, 81, 85, 86, 89, 90, 93, 97, 98 | entrance 0: `dd0007ff 000e3250 at 0x17ac00` |
| `ee` | 9 entrances; scenes 32, 86, 88, 95 | entrance 181: `ee000000 00000000 at 0xfafb8` |

Audio opcodes the mixer rejects:

| Opcode | Hits |
|---|---|
| `0e` | 415 entrances; scenes 0, 2, 3, 4, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 21, 23, 26, 32, 33, 34, 38, 42, 43, 47, 48, 53, 55, 56, 57, 58, 59, 61, 62, 63, 64, 65, 67, 72, 76, 77, 78, 81, 82, 83, 85, 87, 88, 91, 92, 93, 95, 96, 97, 98, 99, 100 |

Display-list problems the interpreter worked around:

| Problem | Hits |
|---|---|
| stray rdp half-word 0x… | 462 entrances; scenes 0, 1, 2, 6, 7, 9, 11, 12, 13, 14, 18, 20, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 41, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 55, 56, 57, 58, 60, 61, 62, 63, 67, 69, 72, 74, 75, 81, 82, 83, 84, 85, 86, 88, 89, 90, 92, 93, 94, 95, 96, 97, 98, 99, 100 |

Blank frames:

| Kind | Hits | Entrances |
|---|---|---|
| no-geometry | 12 entrances; scenes 83, 85, 94, 100 | 889–892, 1168–1169, 1424–1425, 1528–1531 |

Entrances after which the play state shows another scene than the entry the game loaded (index plus setup variant) names. The game redirects some entries itself, and an entry with a cutscene setup shifts the variant:

| Entrance | Table scene | Variant | Loaded entry | Its scene | Reached scene |
|---|---|---|---|---|---|
| 553 | 90 | 1 | 553 | 90 | 93 |
| 554 | 90 | 1 | 554 | 90 | 93 |
| 555 | 90 | 1 | 555 | 90 | 93 |
| 556 | 90 | 1 | 556 | 90 | 93 |
| 889 | 99 | 0 | 889 | 99 | 94 |
| 890 | 99 | 0 | 890 | 99 | 94 |
| 891 | 99 | 0 | 891 | 99 | 94 |
| 892 | 46 | 0 | 892 | 46 | 94 |
| 1168 | 12 | 0 | 1168 | 12 | 100 |
| 1169 | 12 | 0 | 1169 | 12 | 100 |
| 1304 | 79 | 4 | 1308 | 26 | 79 |
| 1305 | 79 | 4 | 1309 | 26 | 79 |
| 1306 | 79 | 4 | 1310 | 26 | 79 |
| 1307 | 79 | 4 | 1311 | 26 | 79 |
| 1308 | 26 | 4 | 1311 | 26 | 79 |
| 1424 | 67 | 0 | 1424 | 67 | 83 |
| 1425 | 67 | 0 | 1425 | 67 | 83 |
| 1504 | 91 | 4 | 1508 | 76 | 91 |
| 1528 | 93 | 0 | 1528 | 93 | 85 |
| 1529 | 93 | 0 | 1529 | 93 | 85 |
| 1530 | 93 | 0 | 1530 | 93 | 85 |
| 1531 | 93 | 0 | 1531 | 93 | 85 |

Executed RSP tasks: type 4 microcode `0x800066c0` ×52; type 1 microcode `0x800e1ec0` ×495011; type 2 microcode `0x800e0f10` ×1425021; type 4 microcode `0x800e4b10` ×17475.

Graphics opcodes executed (opcode ×count): `01`×32484057 `02`×254233 `03`×2432002 `04`×75678 `05`×9889088 `06`×115675233 `07`×2970477 `0a`×8681 `d7`×17698546 `d8`×260081 `d9`×31970133 `da`×18122145 `db`×16737559 `dc`×14271112 `dd`×17362 `de`×22722507 `df`×20890242 `e1`×2200973 `e2`×10815758 `e3`×14560249 `e4`×2107933 `e6`×35976481 `e7`×71432686 `e8`×7431095 `e9`×146975 `ed`×1793432 `ee`×179 `ef`×5400682 `f0`×6513562 `f1`×2107933 `f2`×39458893 `f3`×24798824 `f4`×4664095 `f5`×66428668 `f6`×440182 `f7`×338090 `f8`×306310 `f9`×440925 `fa`×16192077 `fb`×3466933 `fc`×18632115 `fd`×35976481 `fe`×440925 `ff`×881850.

Executed graphics opcodes the interpreter lacks: `2`, `4`, `a`, `dd`, `ee`.

Audio opcodes executed (opcode ×count): `01`×15586874 `02`×1834571 `05`×14520738 `07`×16584738 `08`×30107612 `09`×20843 `0a`×7931509 `0b`×9063857 `0c`×13833015 `0d`×1807364 `0e`×498709 `0f`×147222 `11`×2363870 `12`×14298794 `13`×14298794 `14`×26146344 `15`×12249331 `16`×14298794.

Audio opcodes the mixer lacked when the sweep ran: `0`, `3`, `4`, `6`, `e` (since implemented), `17`; of the implemented ones, never executed: `10`.

Coverage: 4976 of 13365 recompiled functions ran (boot 39 of 144, main code 1795 of 2963, overlays 3141 of 10046); 279 of 468 overlays with code had a function run; 61 of 73 replaced OS routines were called (calls made through the dispatch table are not counted). Overlays no function of which ran: `ovl_0031`, `ovl_0034`, `ovl_0037`, `ovl_0039`, `ovl_0043`, `ovl_0045`, `ovl_0047`, `ovl_0050`, `ovl_0057`, `ovl_0058`, `ovl_0062`, `ovl_0064`, `ovl_0065`, `ovl_0068`, `ovl_0069`, `ovl_0070`, `ovl_0071`, `ovl_0072`, `ovl_0073`, `ovl_0075`, `ovl_0084`, `ovl_0085`, `ovl_0086`, `ovl_0087`, `ovl_0088`, `ovl_0089`, `ovl_0093`, `ovl_0095`, `ovl_0098`, `ovl_0099`, `ovl_0100`, `ovl_0101`, `ovl_0105`, `ovl_0106`, `ovl_0110`, `ovl_0111`, `ovl_0114`, `ovl_0116`, `ovl_0117`, `ovl_0118`, `ovl_0121`, `ovl_0123`, `ovl_0126`, `ovl_0128`, `ovl_0132`, `ovl_0133`, `ovl_0135`, `ovl_0136`, `ovl_0138`, `ovl_0139`, `ovl_0142`, `ovl_0149`, `ovl_0150`, `ovl_0153`, `ovl_0155`, `ovl_0161`, `ovl_0166`, `ovl_0167`, `ovl_0170`, `ovl_0171`, `ovl_0172`, `ovl_0173`, `ovl_0177`, `ovl_0178`, `ovl_0180`, `ovl_0182`, `ovl_0183`, `ovl_0184`, `ovl_0188`, `ovl_0189`, `ovl_0193`, `ovl_0194`, `ovl_0195`, `ovl_0203`, `ovl_0204`, `ovl_0208`, `ovl_0212`, `ovl_0215`, `ovl_0216`, `ovl_0218`, `ovl_0221`, `ovl_0222`, `ovl_0225`, `ovl_0226`, `ovl_0227`, `ovl_0228`, `ovl_0229`, `ovl_0231`, `ovl_0241`, `ovl_0243`, `ovl_0245`, `ovl_0248`, `ovl_0249`, `ovl_0250`, `ovl_0251`, `ovl_0255`, `ovl_0259`, `ovl_0268`, `ovl_0269`, `ovl_0270`, `ovl_0271`, `ovl_0277`, `ovl_0278`, `ovl_0279`, `ovl_0280`, `ovl_0281`, `ovl_0283`, `ovl_0285`, `ovl_0288`, `ovl_0296`, `ovl_0297`, `ovl_0300`, `ovl_0301`, `ovl_0305`, `ovl_0306`, `ovl_0307`, `ovl_0310`, `ovl_0311`, `ovl_0313`, `ovl_0315`, `ovl_0316`, `ovl_0320`, `ovl_0321`, `ovl_0328`, `ovl_0332`, `ovl_0334`, `ovl_0336`, `ovl_0340`, `ovl_0342`, `ovl_0345`, `ovl_0346`, `ovl_0353`, `ovl_0361`, `ovl_0366`, `ovl_0367`, `ovl_0374`, `ovl_0375`, `ovl_0376`, `ovl_0378`, `ovl_0380`, `ovl_0383`, `ovl_0386`, `ovl_0389`, `ovl_0391`, `ovl_0392`, `ovl_0393`, `ovl_0397`, `ovl_0398`, `ovl_0399`, `ovl_0400`, `ovl_0402`, `ovl_0403`, `ovl_0404`, `ovl_0405`, `ovl_0406`, `ovl_0408`, `ovl_0409`, `ovl_0410`, `ovl_0411`, `ovl_0412`, `ovl_0413`, `ovl_0414`, `ovl_0416`, `ovl_0417`, `ovl_0418`, `ovl_0419`, `ovl_0420`, `ovl_0421`, `ovl_0422`, `ovl_0423`, `ovl_0426`, `ovl_0431`, `ovl_0435`, `ovl_0436`, `ovl_0439`, `ovl_0461`, `ovl_0462`, `ovl_0463`, `ovl_0465`, `ovl_0467`, `ovl_0469`, `ovl_0476`, `ovl_0480`, `ovl_0483`, `ovl_0486`, `ovl_0488`, `ovl_0490`, `ovl_0492`, `ovl_0498`.

Accesses beyond RDRAM, in 256-byte blocks (the first address touched; the function entered last when it was first touched is only a hint):

Hardware registers and cartridge space (the replaced routines never reach the hardware, so each of these is recompiled code touching a device):

| Address | Register | Accesses | Function entered last | Seen in |
|---|---|---|---|---|
| `0xa4000ff4` | SP_DMEM+0xff4 | 104 | `0x800a34b4` | the scripted start (boot, title, file select, opening) |
| `0xa4600010` | PI_STATUS | 1144 | `0x80002ff0` | the scripted start (boot, title, file select, opening) |
| `0xa6000000` | 0x6000000 | 52 | `0x80002ff0` | the scripted start (boot, title, file select, opening) |
| `0xb0000000` | CART_ROM+0x0 | 52 | `0x80002ff0` | the scripted start (boot, title, file select, opening) |

Other addresses (not a device: a wild pointer, or a read past the end of RDRAM):

| Address | Kind | Accesses | Function entered last | Seen in |
|---|---|---|---|---|
| `0x44810002` | user segment (unmapped) | 5852 | `0x8007999c` | 4 entrances; scenes 7 |
| `0x44810130` | user segment (unmapped) | 400 | `0x80081c38` | 4 entrances; scenes 7 |
| `0x80800000` | just past the 8 MiB of RDRAM | 7714 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80800100` | just past the 8 MiB of RDRAM | 7908 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80800200` | just past the 8 MiB of RDRAM | 7660 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80800300` | just past the 8 MiB of RDRAM | 8738 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80800400` | just past the 8 MiB of RDRAM | 7936 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80800500` | just past the 8 MiB of RDRAM | 8818 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80800600` | just past the 8 MiB of RDRAM | 8594 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80800700` | just past the 8 MiB of RDRAM | 8606 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80800800` | just past the 8 MiB of RDRAM | 9208 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80800900` | just past the 8 MiB of RDRAM | 9098 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80800a00` | just past the 8 MiB of RDRAM | 8986 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80800b00` | just past the 8 MiB of RDRAM | 8622 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80800c00` | just past the 8 MiB of RDRAM | 9636 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80800d00` | just past the 8 MiB of RDRAM | 8716 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80800e00` | just past the 8 MiB of RDRAM | 8524 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80800f00` | just past the 8 MiB of RDRAM | 8132 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80801000` | just past the 8 MiB of RDRAM | 8144 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80801100` | just past the 8 MiB of RDRAM | 8976 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80801200` | just past the 8 MiB of RDRAM | 8104 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80801300` | just past the 8 MiB of RDRAM | 8210 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80801400` | just past the 8 MiB of RDRAM | 8838 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80801500` | just past the 8 MiB of RDRAM | 8524 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80801600` | just past the 8 MiB of RDRAM | 9302 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80801700` | just past the 8 MiB of RDRAM | 9346 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80801800` | just past the 8 MiB of RDRAM | 8466 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80801900` | just past the 8 MiB of RDRAM | 9282 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80801a00` | just past the 8 MiB of RDRAM | 8338 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80801b00` | just past the 8 MiB of RDRAM | 9016 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80801c00` | just past the 8 MiB of RDRAM | 7996 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80801d00` | just past the 8 MiB of RDRAM | 8528 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80801e00` | just past the 8 MiB of RDRAM | 8300 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80801f00` | just past the 8 MiB of RDRAM | 8040 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80802000` | just past the 8 MiB of RDRAM | 8080 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80802100` | just past the 8 MiB of RDRAM | 8790 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80802200` | just past the 8 MiB of RDRAM | 8760 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80802300` | just past the 8 MiB of RDRAM | 8864 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80802400` | just past the 8 MiB of RDRAM | 9658 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80802500` | just past the 8 MiB of RDRAM | 8076 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80802600` | just past the 8 MiB of RDRAM | 9508 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80802700` | just past the 8 MiB of RDRAM | 8290 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80802800` | just past the 8 MiB of RDRAM | 7836 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80802900` | just past the 8 MiB of RDRAM | 9420 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80802a00` | just past the 8 MiB of RDRAM | 8728 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80802b00` | just past the 8 MiB of RDRAM | 8578 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80802c00` | just past the 8 MiB of RDRAM | 10974 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80802d00` | just past the 8 MiB of RDRAM | 8516 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80802e00` | just past the 8 MiB of RDRAM | 8424 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80802f00` | just past the 8 MiB of RDRAM | 8216 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80803000` | just past the 8 MiB of RDRAM | 8502 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80803100` | just past the 8 MiB of RDRAM | 8794 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80803200` | just past the 8 MiB of RDRAM | 8564 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80803300` | just past the 8 MiB of RDRAM | 8674 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80803400` | just past the 8 MiB of RDRAM | 9516 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80803500` | just past the 8 MiB of RDRAM | 8696 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80803600` | just past the 8 MiB of RDRAM | 8070 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80803700` | just past the 8 MiB of RDRAM | 8320 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80803800` | just past the 8 MiB of RDRAM | 8632 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80803900` | just past the 8 MiB of RDRAM | 8336 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80803a00` | just past the 8 MiB of RDRAM | 8168 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80803b00` | just past the 8 MiB of RDRAM | 8860 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80803c00` | just past the 8 MiB of RDRAM | 9738 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80803d00` | just past the 8 MiB of RDRAM | 8316 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80803e00` | just past the 8 MiB of RDRAM | 9026 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80803f00` | just past the 8 MiB of RDRAM | 8128 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80804000` | just past the 8 MiB of RDRAM | 8526 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80804100` | just past the 8 MiB of RDRAM | 8676 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80804200` | just past the 8 MiB of RDRAM | 8680 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80804300` | just past the 8 MiB of RDRAM | 8264 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80804400` | just past the 8 MiB of RDRAM | 8432 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80804500` | just past the 8 MiB of RDRAM | 8288 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80804600` | just past the 8 MiB of RDRAM | 9050 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80804700` | just past the 8 MiB of RDRAM | 8982 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80804800` | just past the 8 MiB of RDRAM | 7756 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80804900` | just past the 8 MiB of RDRAM | 9094 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80804a00` | just past the 8 MiB of RDRAM | 8898 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80804b00` | just past the 8 MiB of RDRAM | 8724 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80804c00` | just past the 8 MiB of RDRAM | 8778 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80804d00` | just past the 8 MiB of RDRAM | 8682 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80804e00` | just past the 8 MiB of RDRAM | 8456 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80804f00` | just past the 8 MiB of RDRAM | 9320 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80805000` | just past the 8 MiB of RDRAM | 9106 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80805100` | just past the 8 MiB of RDRAM | 8420 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80805200` | just past the 8 MiB of RDRAM | 9004 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80805300` | just past the 8 MiB of RDRAM | 8074 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80805400` | just past the 8 MiB of RDRAM | 8442 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80805500` | just past the 8 MiB of RDRAM | 9190 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80805600` | just past the 8 MiB of RDRAM | 8822 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80805700` | just past the 8 MiB of RDRAM | 8404 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80805800` | just past the 8 MiB of RDRAM | 8570 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80805900` | just past the 8 MiB of RDRAM | 8602 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80805a00` | just past the 8 MiB of RDRAM | 8180 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80805b00` | just past the 8 MiB of RDRAM | 8788 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80805c00` | just past the 8 MiB of RDRAM | 8776 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80805d00` | just past the 8 MiB of RDRAM | 10374 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80805e00` | just past the 8 MiB of RDRAM | 8262 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80805f00` | just past the 8 MiB of RDRAM | 8318 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80806000` | just past the 8 MiB of RDRAM | 8838 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80806100` | just past the 8 MiB of RDRAM | 8060 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80806200` | just past the 8 MiB of RDRAM | 9580 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80806300` | just past the 8 MiB of RDRAM | 9096 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80806400` | just past the 8 MiB of RDRAM | 9326 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80806500` | just past the 8 MiB of RDRAM | 7992 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80806600` | just past the 8 MiB of RDRAM | 8348 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80806700` | just past the 8 MiB of RDRAM | 8064 | `0x800a34b4` | 10 entrances; scenes 6 |
| `0x80806800` | just past the 8 MiB of RDRAM | 7474 | `0x800a34b4` | 6 entrances; scenes  |
| `0x80806900` | just past the 8 MiB of RDRAM | 7612 | `0x800a34b4` | 6 entrances; scenes  |
| `0x80806a00` | just past the 8 MiB of RDRAM | 7726 | `0x800a34b4` | 6 entrances; scenes  |
| `0x80806b00` | just past the 8 MiB of RDRAM | 7076 | `0x800a34b4` | 6 entrances; scenes  |
| `0x80806c00` | just past the 8 MiB of RDRAM | 7558 | `0x800a34b4` | 6 entrances; scenes  |
| `0x80806d00` | just past the 8 MiB of RDRAM | 7162 | `0x800a34b4` | 6 entrances; scenes  |
| `0x80806e00` | just past the 8 MiB of RDRAM | 7136 | `0x800a34b4` | 6 entrances; scenes  |
| `0x80806f00` | just past the 8 MiB of RDRAM | 9346 | `0x800a34b4` | 6 entrances; scenes  |
| `0x80807000` | just past the 8 MiB of RDRAM | 9010 | `0x800a34b4` | 6 entrances; scenes  |
| `0x80807100` | just past the 8 MiB of RDRAM | 8450 | `0x800a34b4` | 6 entrances; scenes  |
| `0x80807200` | just past the 8 MiB of RDRAM | 7314 | `0x800a34b4` | 6 entrances; scenes  |
| `0x80807300` | just past the 8 MiB of RDRAM | 8482 | `0x800a34b4` | 6 entrances; scenes  |
| `0x80807400` | just past the 8 MiB of RDRAM | 7242 | `0x800a34b4` | 6 entrances; scenes  |
| `0x80807500` | just past the 8 MiB of RDRAM | 6930 | `0x800a34b4` | 6 entrances; scenes  |
| `0x80807600` | just past the 8 MiB of RDRAM | 7012 | `0x800a34b4` | 6 entrances; scenes  |
| `0x80807700` | just past the 8 MiB of RDRAM | 7092 | `0x800a34b4` | 6 entrances; scenes  |
| `0x80807800` | just past the 8 MiB of RDRAM | 7654 | `0x800a34b4` | 6 entrances; scenes  |
| `0x80807900` | just past the 8 MiB of RDRAM | 7020 | `0x800a34b4` | 6 entrances; scenes  |
| `0x80807a00` | just past the 8 MiB of RDRAM | 6700 | `0x800a34b4` | 6 entrances; scenes  |
| `0x80807b00` | just past the 8 MiB of RDRAM | 5684 | `0x800a34b4` | 6 entrances; scenes  |
| `0x80807c00` | just past the 8 MiB of RDRAM | 5776 | `0x8000099c` | 6 entrances; scenes  |
| `0x80807d00` | just past the 8 MiB of RDRAM | 6232 | `0x8000099c` | 6 entrances; scenes  |
| `0x80807e00` | just past the 8 MiB of RDRAM | 5740 | `0x8000099c` | 6 entrances; scenes  |
| `0x80807f00` | just past the 8 MiB of RDRAM | 5372 | `0x8000099c` | 6 entrances; scenes  |
| `0x80808000` | just past the 8 MiB of RDRAM | 6158 | `0x8000099c` | 6 entrances; scenes  |
| `0x80808100` | just past the 8 MiB of RDRAM | 6018 | `0x8000099c` | 6 entrances; scenes  |
| `0x80808200` | just past the 8 MiB of RDRAM | 6862 | `0x8000099c` | 6 entrances; scenes  |
| `0x80808300` | just past the 8 MiB of RDRAM | 5650 | `0x8000099c` | 6 entrances; scenes  |
| `0x80808400` | just past the 8 MiB of RDRAM | 5726 | `0x8000099c` | 6 entrances; scenes  |
| `0x80808500` | just past the 8 MiB of RDRAM | 5638 | `0x8000099c` | 6 entrances; scenes  |
| `0x80808600` | just past the 8 MiB of RDRAM | 6362 | `0x8000099c` | 6 entrances; scenes  |
| `0x80808700` | just past the 8 MiB of RDRAM | 7020 | `0x8000099c` | 6 entrances; scenes  |
| `0x80808800` | just past the 8 MiB of RDRAM | 5784 | `0x8000099c` | 6 entrances; scenes  |
| `0x80808900` | just past the 8 MiB of RDRAM | 6148 | `0x8000099c` | 6 entrances; scenes  |
| `0x80808a00` | just past the 8 MiB of RDRAM | 6392 | `0x8000099c` | 6 entrances; scenes  |
| `0x80808b00` | just past the 8 MiB of RDRAM | 6024 | `0x8000099c` | 6 entrances; scenes  |
| `0x80808c00` | just past the 8 MiB of RDRAM | 5710 | `0x8000099c` | 6 entrances; scenes  |
| `0x80808d00` | just past the 8 MiB of RDRAM | 6072 | `0x8000099c` | 6 entrances; scenes  |
| `0x80808e00` | just past the 8 MiB of RDRAM | 5782 | `0x8000099c` | 6 entrances; scenes  |
| `0x80808f00` | just past the 8 MiB of RDRAM | 5476 | `0x8000099c` | 6 entrances; scenes  |
| `0x80809000` | just past the 8 MiB of RDRAM | 5232 | `0x8000099c` | 6 entrances; scenes  |
| `0x80809100` | just past the 8 MiB of RDRAM | 4120 | `0x80004f70` | 6 entrances; scenes  |
| `0x80809200` | just past the 8 MiB of RDRAM | 4058 | `0x80004f70` | 6 entrances; scenes  |
| `0x80809300` | just past the 8 MiB of RDRAM | 3712 | `0x80004f70` | 6 entrances; scenes  |
| `0x80809400` | just past the 8 MiB of RDRAM | 4174 | `0x80004f70` | 6 entrances; scenes  |
| `0x80809500` | just past the 8 MiB of RDRAM | 4234 | `0x80004f70` | 6 entrances; scenes  |
| `0x80809600` | just past the 8 MiB of RDRAM | 4228 | `0x80004f70` | 6 entrances; scenes  |
| `0x80809700` | just past the 8 MiB of RDRAM | 4036 | `0x80004f70` | 6 entrances; scenes  |
| `0x80809800` | just past the 8 MiB of RDRAM | 4714 | `0x80004f70` | 6 entrances; scenes  |
| `0x80809900` | just past the 8 MiB of RDRAM | 4138 | `0x80004f70` | 6 entrances; scenes  |
| `0x80809a00` | just past the 8 MiB of RDRAM | 3976 | `0x80004f70` | 6 entrances; scenes  |
| `0x80809b00` | just past the 8 MiB of RDRAM | 4464 | `0x80004f70` | 6 entrances; scenes  |
| `0x80809c00` | just past the 8 MiB of RDRAM | 4084 | `0x80004f70` | 6 entrances; scenes  |
| `0x80809d00` | just past the 8 MiB of RDRAM | 3998 | `0x80004f70` | 6 entrances; scenes  |
| `0x80809e00` | just past the 8 MiB of RDRAM | 3830 | `0x80004f70` | 6 entrances; scenes  |
| `0x80809f00` | just past the 8 MiB of RDRAM | 3770 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080a000` | just past the 8 MiB of RDRAM | 4478 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080a100` | just past the 8 MiB of RDRAM | 4196 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080a200` | just past the 8 MiB of RDRAM | 4480 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080a300` | just past the 8 MiB of RDRAM | 4686 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080a400` | just past the 8 MiB of RDRAM | 3984 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080a500` | just past the 8 MiB of RDRAM | 3954 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080a600` | just past the 8 MiB of RDRAM | 4190 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080a700` | just past the 8 MiB of RDRAM | 3750 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080a800` | just past the 8 MiB of RDRAM | 4024 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080a900` | just past the 8 MiB of RDRAM | 4886 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080aa00` | just past the 8 MiB of RDRAM | 4534 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080ab00` | just past the 8 MiB of RDRAM | 3668 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080ac00` | just past the 8 MiB of RDRAM | 4168 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080ad00` | just past the 8 MiB of RDRAM | 3834 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080ae00` | just past the 8 MiB of RDRAM | 3992 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080af00` | just past the 8 MiB of RDRAM | 3892 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080b000` | just past the 8 MiB of RDRAM | 4218 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080b100` | just past the 8 MiB of RDRAM | 3758 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080b200` | just past the 8 MiB of RDRAM | 3682 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080b300` | just past the 8 MiB of RDRAM | 3962 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080b400` | just past the 8 MiB of RDRAM | 3884 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080b500` | just past the 8 MiB of RDRAM | 3722 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080b600` | just past the 8 MiB of RDRAM | 4174 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080b700` | just past the 8 MiB of RDRAM | 4676 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080b800` | just past the 8 MiB of RDRAM | 4270 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080b900` | just past the 8 MiB of RDRAM | 3886 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080ba00` | just past the 8 MiB of RDRAM | 4122 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080bb00` | just past the 8 MiB of RDRAM | 3954 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080bc00` | just past the 8 MiB of RDRAM | 3898 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080bd00` | just past the 8 MiB of RDRAM | 4090 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080be00` | just past the 8 MiB of RDRAM | 3988 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080bf00` | just past the 8 MiB of RDRAM | 3714 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080c000` | just past the 8 MiB of RDRAM | 4200 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080c100` | just past the 8 MiB of RDRAM | 4602 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080c200` | just past the 8 MiB of RDRAM | 4022 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080c300` | just past the 8 MiB of RDRAM | 4018 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080c400` | just past the 8 MiB of RDRAM | 3914 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080c500` | just past the 8 MiB of RDRAM | 3816 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080c600` | just past the 8 MiB of RDRAM | 4336 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080c700` | just past the 8 MiB of RDRAM | 3716 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080c800` | just past the 8 MiB of RDRAM | 3952 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080c900` | just past the 8 MiB of RDRAM | 3660 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080ca00` | just past the 8 MiB of RDRAM | 4076 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080cb00` | just past the 8 MiB of RDRAM | 4462 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080cc00` | just past the 8 MiB of RDRAM | 4348 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080cd00` | just past the 8 MiB of RDRAM | 4140 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080ce00` | just past the 8 MiB of RDRAM | 3704 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080cf00` | just past the 8 MiB of RDRAM | 4568 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080d000` | just past the 8 MiB of RDRAM | 3850 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080d100` | just past the 8 MiB of RDRAM | 4028 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080d200` | just past the 8 MiB of RDRAM | 4016 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080d300` | just past the 8 MiB of RDRAM | 4042 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080d400` | just past the 8 MiB of RDRAM | 4692 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080d500` | just past the 8 MiB of RDRAM | 4050 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080d600` | just past the 8 MiB of RDRAM | 4160 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080d700` | just past the 8 MiB of RDRAM | 4138 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080d800` | just past the 8 MiB of RDRAM | 4072 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080d900` | just past the 8 MiB of RDRAM | 4434 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080da00` | just past the 8 MiB of RDRAM | 4420 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080db00` | just past the 8 MiB of RDRAM | 3902 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080dc00` | just past the 8 MiB of RDRAM | 3642 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080dd00` | just past the 8 MiB of RDRAM | 4014 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080de00` | just past the 8 MiB of RDRAM | 4106 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080df00` | just past the 8 MiB of RDRAM | 4016 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080e000` | just past the 8 MiB of RDRAM | 3856 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080e100` | just past the 8 MiB of RDRAM | 3850 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080e200` | just past the 8 MiB of RDRAM | 4400 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080e300` | just past the 8 MiB of RDRAM | 4438 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080e400` | just past the 8 MiB of RDRAM | 4210 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080e500` | just past the 8 MiB of RDRAM | 3624 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080e600` | just past the 8 MiB of RDRAM | 4080 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080e700` | just past the 8 MiB of RDRAM | 3718 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080e800` | just past the 8 MiB of RDRAM | 4076 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080e900` | just past the 8 MiB of RDRAM | 4168 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080ea00` | just past the 8 MiB of RDRAM | 4288 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080eb00` | just past the 8 MiB of RDRAM | 4012 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080ec00` | just past the 8 MiB of RDRAM | 4142 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080ed00` | just past the 8 MiB of RDRAM | 4368 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080ee00` | just past the 8 MiB of RDRAM | 4306 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080ef00` | just past the 8 MiB of RDRAM | 3862 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080f000` | just past the 8 MiB of RDRAM | 3942 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080f100` | just past the 8 MiB of RDRAM | 4214 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080f200` | just past the 8 MiB of RDRAM | 3824 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080f300` | just past the 8 MiB of RDRAM | 4062 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080f400` | just past the 8 MiB of RDRAM | 4220 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080f500` | just past the 8 MiB of RDRAM | 4532 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080f600` | just past the 8 MiB of RDRAM | 4000 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080f700` | just past the 8 MiB of RDRAM | 5002 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080f800` | just past the 8 MiB of RDRAM | 4136 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080f900` | just past the 8 MiB of RDRAM | 3688 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080fa00` | just past the 8 MiB of RDRAM | 3974 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080fb00` | just past the 8 MiB of RDRAM | 4194 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080fc00` | just past the 8 MiB of RDRAM | 3932 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080fd00` | just past the 8 MiB of RDRAM | 4070 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080fe00` | just past the 8 MiB of RDRAM | 3854 | `0x80004f70` | 6 entrances; scenes  |
| `0x8080ff00` | just past the 8 MiB of RDRAM | 3946 | `0x80004f70` | 6 entrances; scenes  |
| `0x80810000` | just past the 8 MiB of RDRAM | 3650 | `0x80004f70` | 6 entrances; scenes  |
| `0x80810100` | just past the 8 MiB of RDRAM | 4016 | `0x80004f70` | 6 entrances; scenes  |
| `0x80810200` | just past the 8 MiB of RDRAM | 4326 | `0x80004f70` | 6 entrances; scenes  |
| `0x80810300` | just past the 8 MiB of RDRAM | 4470 | `0x80004f70` | 6 entrances; scenes  |
| `0x80810400` | just past the 8 MiB of RDRAM | 4252 | `0x80004f70` | 6 entrances; scenes  |
| `0x80810500` | just past the 8 MiB of RDRAM | 3918 | `0x80004f70` | 6 entrances; scenes  |
| `0x80810600` | just past the 8 MiB of RDRAM | 4146 | `0x80004f70` | 6 entrances; scenes  |
| `0x80810700` | just past the 8 MiB of RDRAM | 3758 | `0x80004f70` | 6 entrances; scenes  |
| `0x80810800` | just past the 8 MiB of RDRAM | 3814 | `0x80004f70` | 6 entrances; scenes  |
| `0x80810900` | just past the 8 MiB of RDRAM | 4102 | `0x80004f70` | 6 entrances; scenes  |
| `0x80810a00` | just past the 8 MiB of RDRAM | 4532 | `0x80004f70` | 6 entrances; scenes  |
| `0x80810b00` | just past the 8 MiB of RDRAM | 3632 | `0x80004f70` | 6 entrances; scenes  |
| `0x80810c00` | just past the 8 MiB of RDRAM | 4290 | `0x80004f70` | 6 entrances; scenes  |
| `0x80810d00` | just past the 8 MiB of RDRAM | 3644 | `0x80004f70` | 6 entrances; scenes  |
| `0x80810e00` | just past the 8 MiB of RDRAM | 4264 | `0x80004f70` | 6 entrances; scenes  |
| `0x80810f00` | just past the 8 MiB of RDRAM | 4554 | `0x80004f70` | 6 entrances; scenes  |
| `0x80811000` | just past the 8 MiB of RDRAM | 3772 | `0x80004f70` | 6 entrances; scenes  |
| `0x80811100` | just past the 8 MiB of RDRAM | 4128 | `0x80004f70` | 6 entrances; scenes  |
| `0x80811200` | just past the 8 MiB of RDRAM | 4184 | `0x80004f70` | 6 entrances; scenes  |
| `0x80811300` | just past the 8 MiB of RDRAM | 4298 | `0x80004f70` | 6 entrances; scenes  |
| `0x80811400` | just past the 8 MiB of RDRAM | 3934 | `0x80004f70` | 6 entrances; scenes  |
| `0x80811500` | just past the 8 MiB of RDRAM | 4556 | `0x80004f70` | 6 entrances; scenes  |
| `0x80811600` | just past the 8 MiB of RDRAM | 3834 | `0x80004f70` | 6 entrances; scenes  |
| `0x80811700` | just past the 8 MiB of RDRAM | 4758 | `0x80004f70` | 6 entrances; scenes  |
| `0x80811800` | just past the 8 MiB of RDRAM | 4276 | `0x80004f70` | 6 entrances; scenes  |
| `0x80811900` | just past the 8 MiB of RDRAM | 4170 | `0x80004f70` | 6 entrances; scenes  |
| `0x80811a00` | just past the 8 MiB of RDRAM | 4314 | `0x80004f70` | 6 entrances; scenes  |
| `0x80811b00` | just past the 8 MiB of RDRAM | 3750 | `0x80004f70` | 6 entrances; scenes  |
| `0x80811c00` | just past the 8 MiB of RDRAM | 3976 | `0x80004f70` | 6 entrances; scenes  |
| `0x80811d00` | just past the 8 MiB of RDRAM | 3854 | `0x80004f70` | 6 entrances; scenes  |
| `0x80811e00` | just past the 8 MiB of RDRAM | 3866 | `0x80004f70` | 6 entrances; scenes  |
| `0x80811f00` | just past the 8 MiB of RDRAM | 3880 | `0x80004f70` | 6 entrances; scenes  |
| `0x80812000` | just past the 8 MiB of RDRAM | 4396 | `0x80004f70` | 6 entrances; scenes  |
| `0x80812100` | just past the 8 MiB of RDRAM | 4182 | `0x80004f70` | 6 entrances; scenes  |
| `0x80812200` | just past the 8 MiB of RDRAM | 4154 | `0x80004f70` | 6 entrances; scenes  |
| `0x80812300` | just past the 8 MiB of RDRAM | 4384 | `0x80004f70` | 6 entrances; scenes  |
| `0x80812400` | just past the 8 MiB of RDRAM | 3962 | `0x80004f70` | 6 entrances; scenes  |
| `0x80812500` | just past the 8 MiB of RDRAM | 4060 | `0x80004f70` | 6 entrances; scenes  |
| `0x80812600` | just past the 8 MiB of RDRAM | 4088 | `0x80004f70` | 6 entrances; scenes  |
| `0x80812700` | just past the 8 MiB of RDRAM | 4222 | `0x80004f70` | 6 entrances; scenes  |
| `0x80812800` | just past the 8 MiB of RDRAM | 3844 | `0x80004f70` | 6 entrances; scenes  |
| `0x80812900` | just past the 8 MiB of RDRAM | 3854 | `0x80004f70` | 6 entrances; scenes  |
| `0x80812a00` | just past the 8 MiB of RDRAM | 3956 | `0x80004f70` | 6 entrances; scenes  |
| `0x80812b00` | just past the 8 MiB of RDRAM | 4304 | `0x80004f70` | 6 entrances; scenes  |
| `0x80812c00` | just past the 8 MiB of RDRAM | 4422 | `0x80004f70` | 6 entrances; scenes  |
| `0x80812d00` | just past the 8 MiB of RDRAM | 3622 | `0x80004f70` | 6 entrances; scenes  |
| `0x80812e00` | just past the 8 MiB of RDRAM | 3792 | `0x80004f70` | 6 entrances; scenes  |
| `0x80812f00` | just past the 8 MiB of RDRAM | 3646 | `0x80004f70` | 6 entrances; scenes  |
| `0x80813000` | just past the 8 MiB of RDRAM | 3890 | `0x80004f70` | 6 entrances; scenes  |
| `0x80813100` | just past the 8 MiB of RDRAM | 4216 | `0x80004f70` | 6 entrances; scenes  |
| `0x80813200` | just past the 8 MiB of RDRAM | 4722 | `0x80004f70` | 6 entrances; scenes  |
| `0x80813300` | just past the 8 MiB of RDRAM | 3942 | `0x80004f70` | 6 entrances; scenes  |
| `0x80813400` | just past the 8 MiB of RDRAM | 4166 | `0x80004f70` | 6 entrances; scenes  |
| `0x80813500` | just past the 8 MiB of RDRAM | 4530 | `0x80004f70` | 6 entrances; scenes  |
| `0x80813600` | just past the 8 MiB of RDRAM | 3666 | `0x80004f70` | 6 entrances; scenes  |
| `0x80813700` | just past the 8 MiB of RDRAM | 3970 | `0x80004f70` | 6 entrances; scenes  |
| `0x80813800` | just past the 8 MiB of RDRAM | 4010 | `0x80004f70` | 6 entrances; scenes  |
| `0x80813900` | just past the 8 MiB of RDRAM | 3708 | `0x80004f70` | 6 entrances; scenes  |
| `0x80813a00` | just past the 8 MiB of RDRAM | 4312 | `0x80004f70` | 6 entrances; scenes  |
| `0x80813b00` | just past the 8 MiB of RDRAM | 4740 | `0x80004f70` | 6 entrances; scenes  |
| `0x80813c00` | just past the 8 MiB of RDRAM | 4416 | `0x80004f70` | 6 entrances; scenes  |
| `0x80813d00` | just past the 8 MiB of RDRAM | 4424 | `0x80004f70` | 6 entrances; scenes  |
| `0x80813e00` | just past the 8 MiB of RDRAM | 4116 | `0x80004f70` | 6 entrances; scenes  |
| `0x80813f00` | just past the 8 MiB of RDRAM | 3742 | `0x80004f70` | 6 entrances; scenes  |
| `0x80814000` | just past the 8 MiB of RDRAM | 3844 | `0x80004f70` | 6 entrances; scenes  |
| `0x80814100` | just past the 8 MiB of RDRAM | 3652 | `0x80004f70` | 6 entrances; scenes  |
| `0x80814200` | just past the 8 MiB of RDRAM | 4002 | `0x80004f70` | 6 entrances; scenes  |
| `0x80814300` | just past the 8 MiB of RDRAM | 4230 | `0x80004f70` | 6 entrances; scenes  |
| `0x80814400` | just past the 8 MiB of RDRAM | 4328 | `0x80004f70` | 6 entrances; scenes  |
| `0x80814500` | just past the 8 MiB of RDRAM | 4834 | `0x80004f70` | 6 entrances; scenes  |
| `0x80814600` | just past the 8 MiB of RDRAM | 4398 | `0x80004f70` | 6 entrances; scenes  |
| `0x80814700` | just past the 8 MiB of RDRAM | 3844 | `0x80004f70` | 6 entrances; scenes  |
| `0x80814800` | just past the 8 MiB of RDRAM | 3718 | `0x80004f70` | 6 entrances; scenes  |
| `0x80814900` | just past the 8 MiB of RDRAM | 3650 | `0x80004f70` | 6 entrances; scenes  |
| `0x80814a00` | just past the 8 MiB of RDRAM | 3888 | `0x80004f70` | 6 entrances; scenes  |
| `0x80814b00` | just past the 8 MiB of RDRAM | 4304 | `0x80004f70` | 6 entrances; scenes  |
| `0x80814c00` | just past the 8 MiB of RDRAM | 4010 | `0x80004f70` | 6 entrances; scenes  |
| `0x80814d00` | just past the 8 MiB of RDRAM | 4264 | `0x80004f70` | 6 entrances; scenes  |
| `0x80814e00` | just past the 8 MiB of RDRAM | 4518 | `0x80004f70` | 6 entrances; scenes  |
| `0x80814f00` | just past the 8 MiB of RDRAM | 3692 | `0x80004f70` | 6 entrances; scenes  |
| `0x80815000` | just past the 8 MiB of RDRAM | 4424 | `0x80004f70` | 6 entrances; scenes  |
| `0x80815100` | just past the 8 MiB of RDRAM | 3744 | `0x80004f70` | 6 entrances; scenes  |
| `0x80815200` | just past the 8 MiB of RDRAM | 4046 | `0x80004f70` | 6 entrances; scenes  |
| `0x80815300` | just past the 8 MiB of RDRAM | 3984 | `0x80004f70` | 6 entrances; scenes  |
| `0x80815400` | just past the 8 MiB of RDRAM | 3886 | `0x80004f70` | 6 entrances; scenes  |
| `0x80815500` | just past the 8 MiB of RDRAM | 3770 | `0x80004f70` | 6 entrances; scenes  |
| `0x80815600` | just past the 8 MiB of RDRAM | 4574 | `0x80004f70` | 6 entrances; scenes  |
| `0x80815700` | just past the 8 MiB of RDRAM | 4272 | `0x80004f70` | 6 entrances; scenes  |
| `0x80815800` | just past the 8 MiB of RDRAM | 3918 | `0x80004f70` | 6 entrances; scenes  |
| `0x80815900` | just past the 8 MiB of RDRAM | 3822 | `0x80004f70` | 6 entrances; scenes  |
| `0x80815a00` | just past the 8 MiB of RDRAM | 3868 | `0x80004f70` | 6 entrances; scenes  |
| `0x80815b00` | just past the 8 MiB of RDRAM | 4030 | `0x80004f70` | 6 entrances; scenes  |
| `0x80815c00` | just past the 8 MiB of RDRAM | 4420 | `0x80004f70` | 6 entrances; scenes  |
| `0x80815d00` | just past the 8 MiB of RDRAM | 4042 | `0x80004f70` | 6 entrances; scenes  |
| `0x80815e00` | just past the 8 MiB of RDRAM | 4150 | `0x80004f70` | 6 entrances; scenes  |
| `0x80815f00` | just past the 8 MiB of RDRAM | 3998 | `0x80004f70` | 6 entrances; scenes  |
| `0x80816000` | just past the 8 MiB of RDRAM | 4020 | `0x80004f70` | 6 entrances; scenes  |
| `0x80816100` | just past the 8 MiB of RDRAM | 4478 | `0x80004f70` | 6 entrances; scenes  |
| `0x80816200` | just past the 8 MiB of RDRAM | 4214 | `0x80004f70` | 6 entrances; scenes  |
| `0x80816300` | just past the 8 MiB of RDRAM | 3950 | `0x80004f70` | 6 entrances; scenes  |
| `0x80816400` | just past the 8 MiB of RDRAM | 4080 | `0x80004f70` | 6 entrances; scenes  |
| `0x80816500` | just past the 8 MiB of RDRAM | 3720 | `0x80004f70` | 6 entrances; scenes  |
| `0x80816600` | just past the 8 MiB of RDRAM | 4404 | `0x80004f70` | 6 entrances; scenes  |
| `0x80816700` | just past the 8 MiB of RDRAM | 4014 | `0x80004f70` | 6 entrances; scenes  |
| `0x80816800` | just past the 8 MiB of RDRAM | 3700 | `0x80004f70` | 6 entrances; scenes  |
| `0x80816900` | just past the 8 MiB of RDRAM | 4396 | `0x80004f70` | 6 entrances; scenes  |
| `0x80816a00` | just past the 8 MiB of RDRAM | 4044 | `0x80004f70` | 6 entrances; scenes  |
| `0x80816b00` | just past the 8 MiB of RDRAM | 4298 | `0x80004f70` | 6 entrances; scenes  |
| `0x80816c00` | just past the 8 MiB of RDRAM | 4030 | `0x80004f70` | 6 entrances; scenes  |
| `0x80816d00` | just past the 8 MiB of RDRAM | 3862 | `0x80004f70` | 6 entrances; scenes  |
| `0x80816e00` | just past the 8 MiB of RDRAM | 4238 | `0x80004f70` | 6 entrances; scenes  |
| `0x80816f00` | just past the 8 MiB of RDRAM | 3840 | `0x80004f70` | 6 entrances; scenes  |
| `0x80817000` | just past the 8 MiB of RDRAM | 4130 | `0x80004f70` | 6 entrances; scenes  |
| `0x80817100` | just past the 8 MiB of RDRAM | 3802 | `0x80004f70` | 6 entrances; scenes  |
| `0x80817200` | just past the 8 MiB of RDRAM | 4280 | `0x80004f70` | 6 entrances; scenes  |
| `0x80817300` | just past the 8 MiB of RDRAM | 4392 | `0x80004f70` | 6 entrances; scenes  |
| `0x80817400` | just past the 8 MiB of RDRAM | 4198 | `0x80004f70` | 6 entrances; scenes  |
| `0x80817500` | just past the 8 MiB of RDRAM | 4206 | `0x80004f70` | 6 entrances; scenes  |
| `0x80817600` | just past the 8 MiB of RDRAM | 4252 | `0x80004f70` | 6 entrances; scenes  |
| `0x80817700` | just past the 8 MiB of RDRAM | 3698 | `0x80004f70` | 6 entrances; scenes  |
| `0x80817800` | just past the 8 MiB of RDRAM | 3654 | `0x80004f70` | 6 entrances; scenes  |
| `0x80817900` | just past the 8 MiB of RDRAM | 4112 | `0x80004f70` | 6 entrances; scenes  |
| `0x80817a00` | just past the 8 MiB of RDRAM | 4030 | `0x80004f70` | 6 entrances; scenes  |
| `0x80817b00` | just past the 8 MiB of RDRAM | 4034 | `0x80004f70` | 6 entrances; scenes  |
| `0x80817c00` | just past the 8 MiB of RDRAM | 4048 | `0x80004f70` | 6 entrances; scenes  |
| `0x80817d00` | just past the 8 MiB of RDRAM | 4058 | `0x80004f70` | 6 entrances; scenes  |
| `0x80817e00` | just past the 8 MiB of RDRAM | 4342 | `0x80004f70` | 6 entrances; scenes  |
| `0x80817f00` | just past the 8 MiB of RDRAM | 4622 | `0x80004f70` | 6 entrances; scenes  |
| `0x80818000` | just past the 8 MiB of RDRAM | 3766 | `0x80004f70` | 6 entrances; scenes  |
| `0x80818100` | just past the 8 MiB of RDRAM | 3920 | `0x80004f70` | 6 entrances; scenes  |
| `0x80818200` | just past the 8 MiB of RDRAM | 4084 | `0x80004f70` | 6 entrances; scenes  |
| `0x80818300` | just past the 8 MiB of RDRAM | 3994 | `0x80004f70` | 6 entrances; scenes  |
| `0x80818400` | just past the 8 MiB of RDRAM | 4372 | `0x80004f70` | 6 entrances; scenes  |
| `0x80818500` | just past the 8 MiB of RDRAM | 3726 | `0x80004f70` | 6 entrances; scenes  |
| `0x80818600` | just past the 8 MiB of RDRAM | 3702 | `0x80004f70` | 6 entrances; scenes  |
| `0x80818700` | just past the 8 MiB of RDRAM | 3928 | `0x80004f70` | 6 entrances; scenes  |
| `0x80818800` | just past the 8 MiB of RDRAM | 4472 | `0x80004f70` | 6 entrances; scenes  |
| `0x80818900` | just past the 8 MiB of RDRAM | 4400 | `0x80004f70` | 6 entrances; scenes  |
| `0x80818a00` | just past the 8 MiB of RDRAM | 4386 | `0x80004f70` | 6 entrances; scenes  |
| `0x80818b00` | just past the 8 MiB of RDRAM | 4564 | `0x80004f70` | 6 entrances; scenes  |
| `0x80818c00` | just past the 8 MiB of RDRAM | 3694 | `0x80004f70` | 6 entrances; scenes  |
| `0x80818d00` | just past the 8 MiB of RDRAM | 3678 | `0x80004f70` | 6 entrances; scenes  |
| `0x80818e00` | just past the 8 MiB of RDRAM | 3952 | `0x80004f70` | 6 entrances; scenes  |
| `0x80818f00` | just past the 8 MiB of RDRAM | 4328 | `0x80004f70` | 6 entrances; scenes  |
| `0x80819000` | just past the 8 MiB of RDRAM | 4422 | `0x80004f70` | 6 entrances; scenes  |
| `0x80819100` | just past the 8 MiB of RDRAM | 4008 | `0x80004f70` | 6 entrances; scenes  |
| `0x80819200` | just past the 8 MiB of RDRAM | 4026 | `0x80004f70` | 6 entrances; scenes  |
| `0x80819300` | just past the 8 MiB of RDRAM | 4130 | `0x80004f70` | 6 entrances; scenes  |
| `0x80819400` | just past the 8 MiB of RDRAM | 4032 | `0x80004f70` | 6 entrances; scenes  |
| `0x80819500` | just past the 8 MiB of RDRAM | 4088 | `0x80004f70` | 6 entrances; scenes  |
| `0x80819600` | just past the 8 MiB of RDRAM | 4674 | `0x80004f70` | 6 entrances; scenes  |
| `0x80819700` | just past the 8 MiB of RDRAM | 4034 | `0x80004f70` | 6 entrances; scenes  |
| `0x80819800` | just past the 8 MiB of RDRAM | 4484 | `0x80004f70` | 6 entrances; scenes  |
| `0x80819900` | just past the 8 MiB of RDRAM | 4034 | `0x80004f70` | 6 entrances; scenes  |
| `0x80819a00` | just past the 8 MiB of RDRAM | 3988 | `0x80004f70` | 6 entrances; scenes  |
| `0x80819b00` | just past the 8 MiB of RDRAM | 3630 | `0x80004f70` | 6 entrances; scenes  |
| `0x80819c00` | just past the 8 MiB of RDRAM | 3790 | `0x80004f70` | 6 entrances; scenes  |
| `0x80819d00` | just past the 8 MiB of RDRAM | 4254 | `0x80004f70` | 6 entrances; scenes  |
| `0x80819e00` | just past the 8 MiB of RDRAM | 4162 | `0x80004f70` | 6 entrances; scenes  |
| `0x80819f00` | just past the 8 MiB of RDRAM | 4020 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081a000` | just past the 8 MiB of RDRAM | 3842 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081a100` | just past the 8 MiB of RDRAM | 4408 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081a200` | just past the 8 MiB of RDRAM | 3758 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081a300` | just past the 8 MiB of RDRAM | 4196 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081a400` | just past the 8 MiB of RDRAM | 3832 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081a500` | just past the 8 MiB of RDRAM | 4312 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081a600` | just past the 8 MiB of RDRAM | 4374 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081a700` | just past the 8 MiB of RDRAM | 4156 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081a800` | just past the 8 MiB of RDRAM | 4422 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081a900` | just past the 8 MiB of RDRAM | 3864 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081aa00` | just past the 8 MiB of RDRAM | 3912 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081ab00` | just past the 8 MiB of RDRAM | 3690 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081ac00` | just past the 8 MiB of RDRAM | 4108 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081ad00` | just past the 8 MiB of RDRAM | 4088 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081ae00` | just past the 8 MiB of RDRAM | 3884 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081af00` | just past the 8 MiB of RDRAM | 3800 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081b000` | just past the 8 MiB of RDRAM | 3922 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081b100` | just past the 8 MiB of RDRAM | 4134 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081b200` | just past the 8 MiB of RDRAM | 3934 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081b300` | just past the 8 MiB of RDRAM | 3978 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081b400` | just past the 8 MiB of RDRAM | 4210 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081b500` | just past the 8 MiB of RDRAM | 4154 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081b600` | just past the 8 MiB of RDRAM | 4278 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081b700` | just past the 8 MiB of RDRAM | 4374 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081b800` | just past the 8 MiB of RDRAM | 3680 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081b900` | just past the 8 MiB of RDRAM | 3986 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081ba00` | just past the 8 MiB of RDRAM | 4236 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081bb00` | just past the 8 MiB of RDRAM | 3908 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081bc00` | just past the 8 MiB of RDRAM | 4090 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081bd00` | just past the 8 MiB of RDRAM | 4048 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081be00` | just past the 8 MiB of RDRAM | 4238 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081bf00` | just past the 8 MiB of RDRAM | 3752 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081c000` | just past the 8 MiB of RDRAM | 4018 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081c100` | just past the 8 MiB of RDRAM | 4222 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081c200` | just past the 8 MiB of RDRAM | 3876 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081c300` | just past the 8 MiB of RDRAM | 4318 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081c400` | just past the 8 MiB of RDRAM | 4768 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081c500` | just past the 8 MiB of RDRAM | 4214 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081c600` | just past the 8 MiB of RDRAM | 4166 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081c700` | just past the 8 MiB of RDRAM | 4314 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081c800` | just past the 8 MiB of RDRAM | 4072 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081c900` | just past the 8 MiB of RDRAM | 4552 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081ca00` | just past the 8 MiB of RDRAM | 4276 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081cb00` | just past the 8 MiB of RDRAM | 3764 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081cc00` | just past the 8 MiB of RDRAM | 4050 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081cd00` | just past the 8 MiB of RDRAM | 4602 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081ce00` | just past the 8 MiB of RDRAM | 3904 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081cf00` | just past the 8 MiB of RDRAM | 4254 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081d000` | just past the 8 MiB of RDRAM | 3780 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081d100` | just past the 8 MiB of RDRAM | 3916 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081d200` | just past the 8 MiB of RDRAM | 3740 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081d300` | just past the 8 MiB of RDRAM | 3668 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081d400` | just past the 8 MiB of RDRAM | 5094 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081d500` | just past the 8 MiB of RDRAM | 4084 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081d600` | just past the 8 MiB of RDRAM | 4110 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081d700` | just past the 8 MiB of RDRAM | 3892 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081d800` | just past the 8 MiB of RDRAM | 4250 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081d900` | just past the 8 MiB of RDRAM | 4162 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081da00` | just past the 8 MiB of RDRAM | 4238 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081db00` | just past the 8 MiB of RDRAM | 3928 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081dc00` | just past the 8 MiB of RDRAM | 3960 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081dd00` | just past the 8 MiB of RDRAM | 4414 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081de00` | just past the 8 MiB of RDRAM | 4250 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081df00` | just past the 8 MiB of RDRAM | 3796 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081e000` | just past the 8 MiB of RDRAM | 4036 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081e100` | just past the 8 MiB of RDRAM | 3638 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081e200` | just past the 8 MiB of RDRAM | 4468 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081e300` | just past the 8 MiB of RDRAM | 4000 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081e400` | just past the 8 MiB of RDRAM | 4212 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081e500` | just past the 8 MiB of RDRAM | 4080 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081e600` | just past the 8 MiB of RDRAM | 5076 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081e700` | just past the 8 MiB of RDRAM | 4074 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081e800` | just past the 8 MiB of RDRAM | 3648 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081e900` | just past the 8 MiB of RDRAM | 3822 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081ea00` | just past the 8 MiB of RDRAM | 4082 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081eb00` | just past the 8 MiB of RDRAM | 3840 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081ec00` | just past the 8 MiB of RDRAM | 4074 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081ed00` | just past the 8 MiB of RDRAM | 3584 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081ee00` | just past the 8 MiB of RDRAM | 3894 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081ef00` | just past the 8 MiB of RDRAM | 3894 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081f000` | just past the 8 MiB of RDRAM | 3796 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081f100` | just past the 8 MiB of RDRAM | 4556 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081f200` | just past the 8 MiB of RDRAM | 3866 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081f300` | just past the 8 MiB of RDRAM | 4064 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081f400` | just past the 8 MiB of RDRAM | 4168 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081f500` | just past the 8 MiB of RDRAM | 3930 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081f600` | just past the 8 MiB of RDRAM | 3988 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081f700` | just past the 8 MiB of RDRAM | 4036 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081f800` | just past the 8 MiB of RDRAM | 4334 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081f900` | just past the 8 MiB of RDRAM | 4062 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081fa00` | just past the 8 MiB of RDRAM | 4342 | `0x80004f70` | 6 entrances; scenes  |
| `0x8081fb00` | just past the 8 MiB of RDRAM | 4282 | `0x80004f70` | 6 entrances; scenes  |
| `0x80a514c8` | just past the 8 MiB of RDRAM | 4 | `0x80081dd4` | 4 entrances; scenes 7 |
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
