# Build and the shared build cache

`npm run port -- --rom <path>` (`tools/port/`) runs six steps: verify, analyse (extract and inventory), classify and write the assets, recompile to C, compile the C with Emscripten, link. Every step except verify is served from a content-addressed cache shared by all worktrees of the machine when its inputs have not changed.

## Timings

Measured on this machine (24 logical cores, Emscripten already installed, `--no-ghidra`, default `-O2`). Times are the per-step lines `npm run port` prints.

| Step | Cold, no cache | Cold, cache on (all misses) | Warm cache, fresh folders | Warm cache, one runtime `.c` changed |
| --- | --- | --- | --- | --- |
| 1 verify | 2 s¹ | 0.4 s | 0.4 s | 0.4 s |
| 2 analyse (extract, inventory) | 3 s | 4.4 s | 0.9 s | 1.0 s |
| 3 classify, write 1,512 assets | 5 s | 5.6 s | 1.5 s | 1.3 s |
| 4 recompile (13,367 functions, 477 files, 89 MB of C) | 5 s | 5.3 s | 0.5 s | 0.5 s |
| 5 compile 488 C files | 47 s | 46.7 s | 1.1 s (488 from the cache) | 1.4 s (1 compiled) |
| 6 link | 34 s | 37.1 s | 0.0 s (restored) | 40.3 s |
| Total | 96 s | 101 s | 6 s | 48 s |

¹ The no-cache run's first line is process start-up plus verify; the cache run times verify alone.

The cache holds about 208 MB for one full build. The `dist/` of the warm run is byte-identical to the one of the cold run and to the one built without the cache.

The floor for a change to a runtime file or to anything else that reaches an object is the link (about 40 s), because the link key covers every object.

Cold builds are slower elsewhere than here: a fresh checkout that has to fetch Emscripten, or a busy machine, takes several minutes. The cache does nothing for a cold start; a first build on a new machine pays everything once.

## What is cached

Each entry is a directory under `<cache>/<kind>/<key>/` holding the files and an `entry.json` with their sizes and SHA-1 hashes.

| Kind | Holds | Key (SHA-256 of) |
| --- | --- | --- |
| `analysis` | `inventory.json` and `elf/` | ROM SHA-1, the source of `tools/analyze/run.ts` and every module it imports, `data/`, `tools/analyze/ghidra/`, Ghidra on or off |
| `assets` | `dist/assets/` (asset files and manifest) | the `analysis` key, the source of `tools/assets/classify.ts` and `write.ts` and what they import |
| `generated-c` | `generated/c/` | the `analysis` key, the source of `tools/recomp/generate.ts` and what it imports, `data/` |
| `obj` | one `.o` file | Emscripten version, object name, the C source, every quoted `#include` it reaches (resolved like the compile does), compile flags (`-O`, warnings, `-DOOT_TRACE`, `-DOOT_COVERAGE`) |
| `link` | `dist/oot.js`, `dist/oot.wasm` | Emscripten version, link flags, the `obj` key of every object in link order |

The Emscripten version is read from `emscripten-version.txt`, `emscripten-revision.txt` and `.emsdk_version` of the toolchain in use. "Source of a tool" is the content of the module and of everything it reaches through relative imports, so a change to `tools/assets/` does not invalidate the extraction.

Next to the shared cache, each worktree's `generated/obj/` keeps a `<name>.o.key` file per object, so a rerun in the same worktree recompiles only objects whose key changed.

## Behaviour

- Progress lines name the outcome per step: `cache hit`, `cache miss` or `cache off`, and for the compile step `compiling N of M C files (U up to date, H from the cache)`.
- Writes are atomic: an entry is built in `<cache>/tmp/` and renamed to its final name, so concurrent worktrees never see half an entry. When two worktrees store the same key, the first wins.
- Restoring checks every file's size and hash. A missing, truncated, changed or unparsable entry is a miss: it is deleted and the step runs normally. A cache that cannot be written (full disk, no permission) leaves the build uncached, not failed.
- Restores copy files; nothing is hard-linked, so a tool that rewrites a build output in place cannot damage an entry.
- `npm run port -- --no-cache` bypasses the shared cache for the run (nothing read, nothing written). The per-worktree object keys still apply.
- Size cap: 10 GB by default, `OOT_CACHE_MAX_GB` overrides it (a positive number, fractions allowed). At the end of a run the least recently used entries (by the modification time of `entry.json`, refreshed on every hit) are deleted until the cache fits. Leftovers in `tmp/` older than an hour are removed at the same time.

## Location and clearing

The cache lives in `~/.zelda-oot-js/cache` (next to the shared saves folder); `OOT_CACHE_DIR` overrides it. It holds data derived from the ROM, so it stays on the machine: it is never committed, uploaded or served (see the ROM handling rule in `AGENTS.md`).

To clear it, delete the folder (`rm -rf ~/.zelda-oot-js/cache`; keep the sibling `saves/` folder). To clear one kind, delete `<cache>/<kind>/`.

## Test suite timings

`npm test` with the ROM (24 logical cores). `tools/recomp/global-setup.ts` analyses and recompiles the game once into `out/test-base/`, then compiles and links through the shared cache, side by side: the `-O2` game, the `-DOOT_COVERAGE` game of the sweep suite, and the same `-O2` objects linked at `-O1` for the cross-build state test (`tools/recomp/test-base.ts`). The suites read these builds back and build nothing: no suite compiles, so no cap on parallel compiles is needed. The `port` test runs one port against the shared cache, asserts that it hits at every step and compares its files with the shared build's.

| Run | Before | After |
| --- | --- | --- |
| Warm (cache filled) | 450 s | 99 s and 100 s |
| Cold (empty cache) | 996 s | 277 s |

Two changes beyond the shared build account for most of the gain:

- The software renderer (`tools/gfx/raster.ts`) spent its time allocating closures and arrays per pixel; `frames` and `boot` rendered 600 frames in about 170 s each and now take under 50 s with identical pictures. Booting itself costs 0.4 s for 600 frames, so sharing boots between tests would have saved almost nothing.
- `headless.test.ts` is split into four files (`headless`, `headless-60hz`, `headless-state`, `headless-forest`, with the helpers in `headless-support.ts`) so that vitest runs them in parallel; each test is unchanged and boots its own game.

The longest file warm is now `web/browser-saves.test.ts` (four tests in series, about 100 s together with the Chrome start-up) next to the 60 Hz headless test.

## Test times

Before: the 2026-10-19 full run, 82 files, about 1,870 s of CPU, 288 s wall, files running in parallel on a loaded machine. After: each file alone, files one after the other (`--no-file-parallelism`), so the two columns are not like for like; the whole-suite wall time is the one that Overseer's test check records, and `out/test-durations.json` (written by `tools/durations-reporter.ts` on every run) lets two runs be compared file by file.

| Step | File | Before (s) | After (s) |
| --- | --- | --- | --- |
| Shared build instead of private builds | `saves/game` | 203 | 8 |
| | `headless/load-save-rom` | 201 | 4 |
| | `web/boot-params` | 162 | 1 |
| Intro played once, then loaded as a state (`tools/headless/intro-state.ts`) | `headless-state` (includes the one replay from boot that makes the states) | 107 | 89 |
| | `headless-forest` | 86 | 16 |
| | `headless` (the third replay from boot became a load) | 62 | 18 |
| | `headless-60hz` | 54 | unchanged: it runs at 60 Hz from boot, which a 50 Hz state cannot replace |
| Boot tests merged | `gfx/frames` + `assets/boot` | 57 + 78 | 23 |
| Single port run | `port/port` | 91 | 11 |
| Smooth motion: 170 recorded frames | `gfx/smooth` | 264 | 70 |
| Harness compile cached | `recomp/fpu` (second run) | 54 | 2 (7 s on a miss) |

Notes:

- The intro states are in `<cache>/intro-state/`, one file per build (the hash of `oot.wasm`, the controller script and the frames), made by the first suite that asks while the others wait on a lock file. They hold ROM-derived data and stay out of the repository. The sweep (`fromIntroState`) and the smooth-motion test load them too.
- `gfx/smooth` records 170 frames, not 120: the game draws 20 frames per second, so 120 frames give about 40 comparisons and the kept `comparisons > 50` assert needs about 50.
- The wall-clock asserts of the sweep (frames per second) and the port (seconds) only log their number now.
- vitest's per-file timing cache is in `<cache>/vitest/`, so a fresh worktree starts its slowest files first. `npm run lint` keeps an ESLint cache in `node_modules/.cache/eslint/`, and `npm run build` no longer runs `tsc` (lint does).
