# Title cards: the area-name pictures (PAL 1.0)

Every address was read from this ROM. Addresses are main-code-file RAM addresses (`0x800116E0` base, file 28) unless stated. Reproduce the lists with `OOT_ROM=<rom> npx tsx tools/assets/title-cards-report.ts` (also writes `out/title-cards/sheet.png`, git-ignored); the observations with `tools/headless/title-card-rom.test.ts`. No picture from the ROM is committed. The English text of the 57 title cards is committed as typed by hand in `web/inspect/card-names.ts` (docs/re/entrances.md, "Names"), at the user's request.

## Where the pictures are

- **Scene table.** 101 records of 20 bytes at `0x800F9440` (file offset 949600; `assets.md`). The 102nd record's place holds display-list words (`db060020 800f6ac8 ...`), so the table has 101 scenes, 0 to 100. Word `+8` is the virtual ROM start of the scene's card file and `+0xC` its end; both are 0 when the scene has none. Read by `0x80020E04` (below) through the pointer to the scene's record that the scene loader stores in the play context at `+0x1242C` (`sw` at `0x8009D6AC`; `lw` at `0x80020E24`, then `lw` of `+8` at `0x80020E28` and `+0xC` at `0x80020E30`).
- **Card files.** Each is `0x2880` bytes (10368) decompressed (all 57 are stored Yaz0-compressed), in files 881 to 937 of the file table. 65 scenes name one and 57 files are named (several scenes share a card). Content: three IA8 pictures of 144 x 24 texels (3456 bytes each), one per language, one after the other. IA8 here is the high nibble = intensity, the low nibble = alpha (the bytes seen are `00` background, `0F` black outline, `FF` white letters).
- **Language.** The drawing routine `0x80020F5C` multiplies width x height (`multu` at `0x80020FA4`) by the byte at `0x801197D9` (`lbu` at `0x80020FAC`) to get the offset of the picture inside the file. `0x801197D9` is the language byte of the save context (`saves.md`: `+0x1409` from `0x801183D0`; 0 English, 1 German, 2 French in the file select's order, `input.md`).

## How a card is started

`0x80020E04(play, record, dest, x, y, width, height, delay)` loads the scene's card file into `dest` with `rom_file_load` (the DMA manager decompresses it) (`jal 0x80000F30` at `0x80020E50`) when its size is not 0 and at most `0x3000` (`sltiu` at `0x80020E40`), then fills a 12-byte record: `+0` dest, `+4` x (160), `+6` y (120), `+8` width (144), `+9` height (24), `+0xA` hold frames (80, `0x80020E80`), `+0xB` delay frames (the argument, 20). `0x80020EA0` counts `+0xB` then `+0xA` down and fades the alpha. The record lives at `+0x1D4C` of the play context. Two callers:

1. **Scene start**, in the overlay of file 35 (`0x808458AC`-`0x80845DBC`, call at `0x80845C20`).
2. **A cutscene command**, `0x80052ED4` in the handler `0x80052BB8` (entry type 15 of command list 3 in a cutscene script, jump tables `0x80105230` and `0x801054CC`). A scan of every scene file for that entry (a `00000003` list header followed by an entry whose first halfword is 15) finds it in scenes 0, 1, 2, 67 and 81-83, 87-90, 92, 93, 95-100; all of them are also reached by the scene-start path, so they add nothing to the coverage below.

## Conditions at scene start (overlay of file 35)

Read at `0x80845B64`-`0x80845C20`; the card is started only when all hold:

1. The scene record's end differs from its start (`0x80845B68`-`0x80845B74`).
2. The byte at `0x80119797` is not 0 (`0x80845B78`; what sets it is not identified).
3. The setup variant (`0x80119730`) is below 4 (`slti` at `0x80845B88`), so not in a cutscene layer.
4. **The entrance record has bit `0x4000` in its low halfword**: `lhu` of `0x800F7BF2 + 4 * (entrance index + variant)` and `andi 0x4000` at `0x80845BAC`-`0x80845BB0` (the entrance table, `gaps.md`; bytes 0 and 1 of a record are scene and spawn).
5. Scene 1 also needs bit 0 of the halfword at `0x801192BA` (`0x80845BC4`-`0x80845BD4`), scene 50 needs bit `0x20` of the halfword at `0x801192A8` (`0x80845BDC`-`0x80845BEC`). What the two flags mean is not identified.

## Observed

Scripted new game of the headless runner, entrance requested through the play state's init (`requestEntrance`), 100 frames later the record at play context `+0x1D4C` read (`tools/headless/title-card-rom.test.ts`):

| Entrance | Scene | Bit `0x4000` | Record |
|---|---|---|---|
| 238 | 85 | set | filled: buffer pointer, `+8` word `0x9018xxxx` (width 0x90, height 0x18), the countdowns moving |
| 40 | 2 | set | filled |
| 614 | 85 | clear | all zero |
| 187 | 52 | set, no card file | all zero |
| 4 | 1 | set, flag `0x801192BA` bit 0 clear | all zero; filled once the bit is set |
| 912 | 50 | set, flag `0x801192A8` bit `0x20` clear | all zero; filled once the bit is set |

(Also entrances 239, 521, 529 of scene 85 and entrance 60 of scene 66 filled the record, in a throwaway run.) The record is filled exactly when conditions 1 to 5 hold.

## Coverage

The Warp tab shows a card for a scene when its record names a card file and at least one entrance naming that scene has bit `0x4000` (`scenesWithCard`, `web/inspect/title-cards.ts`; the entrances come from the running game's table).

- **101 scenes** in the table. **65 have a card** (57 distinct files) and every one of them has entrances with the bit, so all 65 are shown. Scenes 1 and 50 are drawn only while their flag is set (above); the tab marks their picture with that note.
- **36 have none**: 10, 14, 15, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 35, 36, 37, 38, 39, 40, 41, 42, 43, 52, 53, 55, 57, 62, 63, 64, 71, 76, 77, 79. Their entrances may carry bit `0x4000`; with no file nothing is drawn (condition 1; observed for scene 52). The Warp tab shows the user's label, or the numbers.
- Scenes with a card and their file (several share one): 0 886, 1 888, 2 887, 3 881, 4 883, 5 884, 6 885, 7 882, 8 934, 9 890, 11 891, 12 929, 13 889, 16 931, 30 898, 31 898, 32-34 897, 44 903, 45 899, 46 900, 47 901, 48 904, 49 904, 50 936, 51 930, 54 928, 56 906, 58 905, 59 893, 60 925, 61 893, 65 924, 66 895, 67 896, 68 894, 69 892, 70 892, 72 937, 73 926, 74 892, 75 927, 78 904, 80 902, 81 907, 82 908, 83 909, 84 910, 85 911, 86 932, 87 912, 88 913, 89 914, 90 915, 91 916, 92 935, 93 933, 94 917, 95 918, 96 919, 97 920, 98 921, 99 922, 100 923.
- File 1237 (a room file) has the same size by coincidence; no scene record names it.

## Notes for other code

- The generated section of `gaps.md` ("Scene and entrance tables") still says 102 records; the table ends at record 101, whose start word is 0 (the sweep's own rule, `countSceneRecords` in `tools/sweep/scenes.ts`: the first record with start >= end), as the hand-written lines of `gaps.md` say (101). `SCENE_COUNT` in `web/inspect/warp.ts` is 101, so the four entrances naming scene 101 (148 to 151) are refused like the other entrances past the table.

## Pictures of the entrances (what the Warp list shows beside the cards)

Cards cover 65 of 101 scenes, and the Warp list has one row per entrance, so each row also carries a picture of the place the entrance leads to, taken in the game:

- `npm run sweep -- scenes --dist dist --frames 90 --thumbs dist/warp-thumbs [--shard k/n]` (`tools/sweep/scenes.ts`) forces each entrance as the sweep always does (`requestEntrance`), runs 90 frames, and writes the picture shown then at half size (160 x 120) as `dist/warp-thumbs/<entrance, 4 digits>.png`. From the start of the run it writes 0xFF to byte `+0xB` of the title card record (`+0x1D4C` of the play context, the delay counter above) every frame, so the card never fades in over the picture. The picture is the software renderer's, as the other sweep dumps are. An entrance whose run ends in another scene than its table entry names, or traps, gets none.
- The dev and preview servers answer `/warp-thumbs/NNNN.png` from `dist/warp-thumbs` to loopback clients only (`web/game-files.ts`); the Pages build does not carry them, and a row without its picture simply shows no picture. They are ROM-derived and git-ignored with the rest of `dist/`.
- The Warp tab shows, per arrival row (`entrances.md`): the picture of the arrival, the scene's card on the scene heading, the text names, the user's labels and the numbers.

Coverage (1556 table entries, 1519 valid, 37 name scenes past the table; `npx tsx tools/assets/title-cards-report.ts` prints it):

| | entrances |
|---|---|
| with a card | 1227 |
| with an arrival picture | 1490 |
| both | 1200 |
| card only | 27 |
| picture only | 290 |
| neither | 2 |

No picture, with a card (27): 694-697 and 1552-1555 (the run does not end: 694-697 is the floor-probe loop of `gaps.md`, 1552-1555 did not finish within a minute either), 1016-1019 (PI trap of `gaps.md`), 1528-1531 (`thread 0xffed0000 is runnable but was never created`), 877-880, 1156-1157, 1412-1415 and 1504 (the game sends them to another scene: `not-reached`). Neither card nor picture (the list shows the text name of the row all the same): 1305 and 1306 (scene 79, which the game redirects to scene 26; neither has a card): only the user's label or the numbers.

## Pause-screen names (not found)

Files 9 to 14 are named only by code of overlay 34 (the pause screen) and hold its language banks: file 12 shows pause menu captions ("to decide", "map", "to quest..." as IA4 strips), 9 to 11 hold no text. No table was found that maps a scene to a place name for the pause map or the world map, and no picture was matched to a scene through code, so no scene gets a name from this source. The 36 scenes without a card keep the arrival pictures above and the user's labels.
