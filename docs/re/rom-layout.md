# ROM layout (PAL 1.0, `NZLP`, revision 0)

All offsets are in the big-endian (`.z64`) image, 32 MiB (`0x2000000`) long. Findings come from reading this ROM with `tools/rom`; the format of the header and of Yaz0 is also described on public N64 wiki pages.

## Byte order

The first 32-bit word of a valid header reads `80 37 12 40` in big-endian order. The other two common dump orders store the same word differently:

| Format | First four bytes | To convert to big-endian |
| ------ | ---------------- | ------------------------ |
| `.z64` | `80 37 12 40`    | none                     |
| `.v64` | `37 80 40 12`    | swap each pair of bytes  |
| `.n64` | `40 12 37 80`    | reverse each 4-byte word |

Detection looks at those four bytes, not the file extension. The PAL 1.0 SHA-1 `328a1f1beba30ce5e178f031662019eb32c5f3b5` is computed on the big-endian image. A `.n64` copy made from our ROM converts back to the same hash.

## Header (0x00-0x3F)

| Offset | Size | Observed value | Meaning |
| ------ | ---- | -------------- | ------- |
| 0x00 | 4 | `80371240` | PI bus config, doubles as the byte-order marker |
| 0x04 | 4 | `0000000f` | clock rate field |
| 0x08 | 4 | `80000400` | boot entry address |
| 0x10 / 0x14 | 4 / 4 | `b044b569` / `373c1985` | two checksums |
| 0x20 | 20 | `THE LEGEND OF ZELDA ` | internal name |
| 0x3B | 4 | `NZLP` | game code |
| 0x3F | 1 | `00` | revision |

## File table

The ROM is a flat sequence of files addressed through a table of 16-byte records, all big-endian words:

| Word | Name | Meaning |
| ---- | ---- | ------- |
| 0 | virtual start | address of the file once decompressed |
| 1 | virtual end | end of the decompressed file |
| 2 | ROM start | where the stored bytes begin |
| 3 | ROM end | end of a compressed stream, or `0` when the file is stored as is |

**How we found it.** `tools/rom` does not use a fixed offset. It scans every 16-byte-aligned position for the longest run of records that are non-empty, 16-aligned, ordered by virtual address, inside the image, and with a consistent `ROM end`. On this ROM exactly one run of 64 or more records exists (the scan reports a single candidate with the 64-record minimum), starting at `0x7950` with **1511 records**; the record after it is all zeros.

Cross-checks that make the identification solid:

- Record 0 is `{0x00000000, 0x00001060, 0x00000000, 0}`: virtual 0 maps to ROM 0, covering the header (the first 0x1060 bytes).
- Record 2 is `{0x00007950, 0x0000d8c0, 0x00007950, 0}`: the table starts exactly at the first byte of file 2, so the table lies inside one of its own files. File 1 (`0x1060-0x7950`) begins with `27bdffe8 afbf0014`, `addiu sp,sp,-0x18; sw ra,0x14(sp)`, a MIPS function prologue.
- Files 0-6 are stored with virtual start = ROM start and tile ROM `0x0-0x7400c0` without gaps. Files 7 and 8 are stored too, but their virtual start is padded up to the next 0x1000 boundary (`0x741000`, `0x7cb000`) while their ROM ranges stay packed.
- Over all 1511 files, no stored range overlaps another and the ROM ranges, sorted, leave no gap; the last range ends at `0x1f88940`, and the remaining `0x776c0` bytes of the image are not referenced by the table and are not all zero.
- Virtual ranges never overlap and ascend in table order. The file sizes sum to 53,286,960 bytes (about 50.8 MiB).

**Stored vs compressed.** 54 records have `ROM end = 0`: indices 0-8, 15-27 and the odd indices 943-1005. The other 1457 are compressed. For a compressed record the stored range is `[ROM start, ROM end)`, and the first four bytes there are `Yaz0` (verified for all 1457). Example, file 9: virtual `0x7d7000-0x7e2930` (47,408 bytes), stored at `0x7d5160-0x7dbbc0`. The largest compressed stream is 631,168 bytes. All stored ranges are 16-aligned.

## Yaz0

A compressed file starts with a 16-byte header: ASCII `Yaz0`, a big-endian 32-bit decompressed size, and 8 bytes that are zero in all 1457 files. The decompressed size in that header equals `virtual end - virtual start` for all 1457 compressed records.

The body is a series of groups. Each group opens with a flag byte read from the most significant bit down; each bit selects one item:

- bit `1`: copy one literal byte;
- bit `0`: a back reference in two bytes `N R` `R R`, where the distance is `((first & 0x0f) << 8 | second) + 1` bytes behind the output cursor and the length is `N + 2`; if `N` is `0`, a third byte follows and the length is that byte plus `0x12`.

Copies can overlap their own output (distance smaller than length), so they must run byte by byte. Decoding stops once the declared size is reached; the final group may leave unused flag bits. This decoder reproduces the declared size for every one of the 1457 compressed files, which is the evidence that the opcode layout above is right: a wrong length rule would desynchronise the stream long before the end.

## Extraction output

`npm run rom:extract` writes `out/files/<index>_<virtual start>.bin` for each file, plus `out/index.json`: the SHA-1, game code, table offset and one record per file (`index`, `virtualStart`, `virtualEnd`, `romStart`, `romEnd`, `compressed`, `size`, `path`). `out/` is git-ignored.
