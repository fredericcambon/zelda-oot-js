# Code map

Where to look first. Search with grep before reading whole files.

## Runtime (C, Emscripten)
- `runtime/` hand-written runtime for the recompiled code: `main.c` entry, `dispatch.c` calls, `sched.c`/`cont.c` threads, `pi.c` ROM DMA, `vi.c` video interface, `rsp.c` graphics/audio task hand-off, `osinit.c` OS startup, `state.c` save-state snapshot.
- `runtime/gfx/` display-list interpreter: `dl.c` commands, `decode.c` textures, `task.c` task entry, `gfx.h` shared types.
- `runtime/tests/` C unit tests for the runtime.

## Tools (`tools/`, Node/TypeScript)
- `tools/rom/` ROM reading, byte order, file table, Yaz0 (`npm run rom:extract`).
- `tools/elf-wrap/`, `tools/recomp/` ELF wrapping and the MIPS-to-C recompiler (`emit.ts`, `generate.ts`, `fpu.ts`); recompiler tests are `*.test.ts` next to them.
- `tools/analyze/` binary analysis (disassembler, os routines, relocs, Ghidra glue).
- `tools/assets/` scene/actor/skeleton/audio asset extraction and the game pack (`pack.ts`).
- `tools/port/` build the wasm: `build.ts`, `cache.ts`; `browser-shot.ts` captures the browser renderer (crop, diff, sheet), `cdp.ts` Chrome driver.
- `tools/gfx/` display-list tests and helpers: `c-dl.ts` bridge to the C interpreter, `types.ts` draw batches, `image-ops.ts` crop/diff, `raster.ts` soft render (not the player's renderer), `offscreen.ts` off-screen colour images, `vi.ts`.
- `tools/headless/` run the game in Node: `boot.ts` frame stepping, `state.ts` game memory fields, `input.ts`, `load-save.ts`, `state-shot.ts` pictures.
- `tools/runtime/` load and snapshot the wasm instance.
- `tools/audio/` audio microcode reference and synth.
- `tools/saves/` cartridge save (sram) and save-state formats.
- `tools/sweep/` scene sweep (all scenes, loops, thumbnails).
- `tools/tex/` texture dump, hashing and upscaled pack (`location.ts` pack folder).
- `tools/pages/` `npm run pages:deploy` (incremental sync into the cached gh-pages clone: `sync.ts`).
- `tools/actors/` actor picture crops.

## Web (`web/`, Vite)
- `web/main.ts` page start: settings, canvas, keys, panel wiring.
- `web/game.ts` boots the wasm, feeds each graphics task to the renderer, audio, timing.
- `web/renderer.ts` WebGL2 back end (1160+ lines: grep for the function, read by line range); `shader.ts`, `batching.ts`, `post-fx.ts`, `ao.ts`, `point-lights.ts`, `gfx-settings.ts` support it.
- `web/input.ts` keyboard/gamepad to controller 1; `touch.ts` touch.
- `web/saves.ts`, `savestate.ts`, `save-actions.ts`, `save-picker.ts`, `published-saves.ts` saves and save states.
- `web/tex-pack.ts` texture replacement lookup.
- `web/inspect/` in-game inspector: `warp.ts`/`exits.ts` scene warps, `actors.ts`, `memory.ts`, `cheats.ts`, `places.ts`.
- `web/ui/` panel tabs (`warp-tab.ts`, `actors-tab.ts`, `inventory-tab.ts`, `memory-tab.ts`).

## Common tasks
- Rendering bug: reproduce with `tools/port/browser-shot.ts`; then `web/renderer.ts` and `web/shader.ts`; display-list semantics in `runtime/gfx/dl.c` and `docs/re/display-lists.md`.
- Lighting: `web/point-lights.ts`, `web/shader.ts`, `docs/re/lighting.md`.
- Input: `web/input.ts`, `docs/re/input.md`.
- Saves: `web/saves.ts`, `web/savestate.ts`, `tools/saves/`, `docs/re/saves.md`.
- Warps: `web/inspect/warp.ts`, `web/ui/warp-tab.ts`, `docs/re/entrances.md`.
- Texture pack: `tools/tex/`, `web/tex-pack.ts`, `docs/texture-pack.md`.
- Build and cache: `docs/build.md`, `tools/port/build.ts`; web deploy: `docs/web.md`.
- Reverse-engineering notes: `docs/re/*.md` (grep; `gaps.md` is huge).
