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

`npm test` with the ROM (24 logical cores). `tools/recomp/global-setup.ts` builds one `-O2` game into `out/test-base/` through the shared cache before any test file runs; `headless`, `frames`, `boot` and the first `port` test read it (`tools/recomp/test-base.ts`). The `-O1` build of the cross-build state test relinks the same objects, and the coverage build of the sweep suite uses the cache too. The second `port` test runs two ports against the shared cache and asserts that the second hits it at every step.

| Run | Before | After |
| --- | --- | --- |
| Warm (cache filled) | 450 s | 353 s (two runs: 598 s while the machine was busy, then 353 s) |
| Cold (empty cache) | 996 s | 965 s |

The 200 s warm and 400 s cold targets are not met. Warm, the longest file is `headless.test.ts` (about 230 s of serial boots, 109 s for the first test alone) and `frames` and `boot` take about 170 s each in parallel with it. Cold, the sweep suite's coverage compile (490 files) still runs next to the other suites' boots, and the cold port repeats analysis, assets and recompile once. Not done, and the likely way to the targets: sharing game boots between tests inside `headless.test.ts` (about 100 s, makes the tests order-dependent), and building the coverage game in the global setup. Total parallel compiles are not capped: only the global setup and the sweep suite compile.
