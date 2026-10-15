# How to reproduce the findings

REA was not used (see `analysis-tool.md`), so no REA command appears here. These are the exact commands, run from the repository root with Node 20 or later, that regenerate every address and listing the notes cite. The ROM must be PAL 1.0 (`328a1f1beba30ce5e178f031662019eb32c5f3b5`); it is read through `OOT_ROM` and never copied.

```bash
npm ci

# bash
export OOT_ROM="/path/to/The Legend of Zelda Ocarina of Time (EU).z64"
# PowerShell: $env:OOT_ROM = "C:\path\to\rom.z64"
```

## 1. Inventory and OS routines (our own discovery, no download)

```bash
npm run analyze -- --no-ghidra --coverage-doc out/coverage.md
```

Writes `out/inventory.json` (functions per image, the `os` array with each routine's status, address and evidence) and `out/elf/`. `--coverage-doc` keeps the committed `docs/re/coverage.md` untouched. To list the routines:

```bash
node -e "for (const r of require('./out/inventory.json').os.routines) console.log(r.status, r.image, r.addr?.toString(16), r.id)"
```

Expected: 123 `found`, 17 `not-present`, nothing `ambiguous` or `not-found`.

## 2. With Ghidra (what the committed `coverage.md` was produced with)

```bash
npm run analyze:setup      # fetches Ghidra 12.1.4 and a JDK 21 into .tools/ (SHA-256 checked)
npm run analyze            # headless Ghidra over every image, then our discovery; rewrites docs/re/coverage.md
```

## 3. Disassembly cited in the notes

```bash
npx tsx tools/analyze/disasm.ts boot 80000400            # boot_entry, 0x80000400: the function containing the address (needs out/inventory.json)
npx tsx tools/analyze/disasm.ts boot 8000063c 800007c8   # an explicit range
npx tsx tools/analyze/disasm.ts code 800cd160            # overlay_relocate
```

The first argument is `boot`, `code` or `ovl_NNNN` (the file-table index). Addresses are hexadecimal.

## 4. Caller scans (who calls address X)

The notes use "callers of X" for `jal X` opcodes. `os-routines.md` lists each routine's callers inside its evidence; to re-derive one, search the images for the word `0x0C000000 | (X >> 2 & 0x03FFFFFF)`. The inventory also stores each function's direct callees (`calls`).

## 5. Regenerate the reference in `os-routines.md`

```bash
npx tsx tools/analyze/os-doc.ts
```

Only the text between `<!-- os-routines:begin -->` and `<!-- os-routines:end -->` changes.

## 6. Tests

```bash
npx vitest run tools/analyze/os.test.ts       # each listed routine resolves to one address or is marked not present
npx vitest run tools/analyze/inventory.test.ts
```

Both skip when `OOT_ROM` is unset; the inventory test also needs step 1 or 2 first.
