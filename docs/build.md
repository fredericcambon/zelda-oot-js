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

## Limits

A build or a test run must not take over the machine, so the code bounds itself; no wrapper is needed.

| Setting | Default | What it bounds |
| --- | --- | --- |
| `OOT_JOBS` | `max(2, floor(cores / 3))` (8 on 24 cores) | emcc runs at once: compiles and links share one gate per process (`tools/port/limits.ts`), so builds that run together share the cap |
| `EMCC_CORES` | 4 | threads Emscripten starts for one compile or link (set in the toolchain environment, `tools/recomp/toolchain.ts`) |
| `BINARYEN_CORES` | 4 | threads wasm-opt starts during the link |

`EMCC_CORES` and `BINARYEN_CORES` keep a value already set in the environment. `tools/build.mjs`, `npm run port` and the vitest global setup lower their own priority to below normal (`os.setPriority`), which their children inherit; a lower priority set by a wrapper (Idle) is kept.

The test global setup builds the -O2 game, relinks it at -O1, then builds the coverage variant, one after another, serves analyse and recompile from the cache like `npm run port`, and writes the assets once (the coverage build reads them through a junction). `vitest.config.ts` runs at most 6 workers; the suites that boot the whole game or start headless Chrome form a `heavy` project limited to 2.

## Shared dependencies

`npm run deps` (`tools/deps.mjs`, plain Node) hashes `package-lock.json` (sha256) and runs `npm ci` once into `~/.zelda-oot-js/deps/<hash>/` (`OOT_DEPS_DIR` overrides), at below-normal priority, under a lock file so two worktrees never install at once. It then makes `<worktree>/node_modules` a directory junction to that folder's `node_modules`; a missing or empty folder is replaced, a real folder with content is left alone and reported. Hash folders not used for 14 days are removed. Nothing may write into the shared folder: vite (`cacheDir`) and ESLint keep their caches in the worktree's `.cache/`, and `vite.config.ts` lets the dev server read the junction's real path.

Completeness: the `ready` marker holds the top-level entry count of `node_modules` taken at install time. `npm run deps` trusts an install only if `node_modules` still has at least that many entries and `.bin` has launchers for `tsx`, `vite`, `vitest`, `eslint` and `tsc` (one readdir and five stats); otherwise it reinstalls and rewrites the marker. A marker without a count (written by an older version) counts as incomplete and is reinstalled once. This repairs the two wipes of the shared install (2026-10-21, 2026-10-22), which the bare marker never noticed.

Delete protection (Windows): after install, `icacls` adds a deny entry for Everyone, `(OI)(CI)(DE,DC)` (delete and delete-child), on the shared `node_modules`, inherited by every file and folder. Tested on a throwaway tree whose worktree had a `node_modules` junction: `robocopy <empty> <worktree> /MIR` emptied the target (6 of 6 entries gone), while `fs.rm` recursive and force, `Remove-Item -Recurse -Force` (Windows PowerShell 5.1), `rd /s /q`, Python `shutil.rmtree` and `del /s` left it intact. So a plain junction already survives the usual deleters and only a mirroring purge follows it; the deleter Overseer used is not known. With the deny entry, robocopy, `fs.rm`, `Remove-Item` and `rd` run directly against the target all leave it untouched. The read-only attribute was rejected: it did not stop robocopy (target 6 to 0), and `fs.rm` and `Remove-Item -Force` clear it. A different link type was rejected: junctions and symlinks are already not followed by the deleters that lose, and the one that follows reads through any link. Reads, execution and writes are not restricted, so vite, vitest, tsx and eslint run as before (checked in a real `npm ci` install: `tsx -e`, `vitest --version`). Caches are not affected: vite's optimizer writes to `.cache/vite` (`cacheDir`), ESLint to `.cache/eslint`, and `tsc --noEmit` writes nothing; with the deny entry in place `vite` served the page and re-optimized after `.cache/vite/deps` was removed, `npm run lint` passed twice, and no `node_modules/.vite` or `node_modules/.cache` appeared. `deps.mjs` lifts the entry (`icacls ... /remove:d Everyone /T`) before it replaces an incomplete install or prunes an unused one; to delete a shared folder by hand, run that command on its `node_modules` first.

Measured here at Idle priority (3455 files, 96 MB in `node_modules`): `npm ci` in a fresh folder 8.5 s and 96 MB written; the first `npm run deps` for a lock file costs the same once; a fresh worktree afterwards takes 0.1 s and writes one junction.

## What is cached

Restores place files as hard links to the entry (a copy across volumes), so they write no file contents; a file whose size and modification time match the manifest is not hashed again. Anything that rewrites a restored file must replace it (`replaceFile` in `cache.ts`, or delete it first), never write it in place, or the entry would change.

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

`<cache>/tex/<ROM SHA-1>/` is not a cache kind: it holds the texture trial's dump and packs (`docs/texture-pack.md`), which take hours to rebuild, so eviction skips it and the size cap does not count it. Clearing the whole cache deletes it too.

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
- vitest's per-file timing cache is in `<cache>/vitest/`, so a fresh worktree starts its slowest files first. `npm run lint` keeps an ESLint cache in `.cache/eslint/` (vite's cache is in `.cache/vite/`; both per worktree and git-ignored), and `npm run build` no longer runs `tsc` (lint does).
