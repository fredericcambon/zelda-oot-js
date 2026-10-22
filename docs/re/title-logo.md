# Title logo: how the title screen and the logo's fade are recognised

Used by `web/title-edition.ts` to show a line under the logo only while the logo is up, at the logo's own fade.

## Method

The built game (`dist/oot.js`, 60 Hz mode, the browser's default) was run headless through `tools/headless/boot.ts` with no input, then with Start held for 6 frames at frame 2450. At each graphics task the display list was run (`task.displayList()`) and its texture rectangles were listed with their texture size and format, prim colour and screen rectangle; `GAME_MODE` was read at each frame. The "frame" numbers below count game frames from boot; one graphics task runs every 3 of them.

## Game mode word

`0x8011972C` (a word of the main code's bss, also used by `tools/headless/load-save.ts`): 0 at frame 0, 1 from frame 257 (the opening cutscene with the moon, then Epona, then the logo, the title's demo scene), 2 from the first task after Start is pressed (frame 2453, with the logo still on screen, fading), and it stays 2 through the file select. It is 0 in play (the set-up of a save file writes 0 there, `loadRecordIntoPlay`). Mode 1 alone does not say that the logo is up: it holds for the 1,030 frames of the opening before the logo appears, and mode 2 covers the logo's fade-out.

## The logo's draw

Frame 1160 (logo faded in, 85 batches), texture rectangles in 320x240 screen units (x, y of the top-left to the bottom-right):

| Draw | Texture | Prim colour | Rectangle |
| --- | --- | --- | --- |
| "THE LEGEND OF", shadow pass | 72x8, I8 | 0,0,0,A | 154,73 to 226,81 |
| "THE LEGEND OF", fill pass | 72x8, I8 | 200,200,150,A | 153,72 to 225,80 |
| "OCARINA OF TIME", shadow pass | 96x8, I8 | 0,0,0,A | 152,127 to 248,135 |
| "OCARINA OF TIME", fill pass | 96x8, I8 | 200,200,150,A | 151,126 to 247,134 |
| the shield and "ZELDA" | 27 strips of 160x6 or 160x4, RGBA 32-bit | 255,255,255,A | x 80 to 240, y from 20 |

The name of each text row is read from the rendered picture (the I8 strips are the small caps above and below "ZELDA"); the texture sizes, colours and rectangles are what the interpreter reports. All of these draws carry the same prim alpha `A` at every task sampled, and `A` is the logo's fade:

- Fade in: no draw until frame 1034; then `A` = 6 at task 1034, rising by 6 per task (12 at 1037, 18 at 1040, 24 at 1043, ...) to 210 at task 1136.
- Hold: `A` = 210 from task 1136 to the end of the sampled run (frame 2450). The logo never reaches 255.
- After Start (pressed at frame 2450, mode 2 from task 2453): `A` = 210 at 2453, then 185, 160, 135, 110, 85, 60, 35, 10 at the following tasks (-25 per task, 2456 to 2477); from task 2480 no 96x8 or 160-wide draw is made. At task 2525 a 160-wide RGBA32 draw returns (27 strips at alpha 70) in the file select; the 96x8 subtitle draw does not (checked at every change of the draw set up to frame 3100).

So the "OCARINA OF TIME" fill pass (a 96x8 I8 texrect with prim colour 200,200,150) is drawn only while the title logo is up, with its alpha as the fade; that is what `logoAlpha` looks for. The page also requires `GAME_MODE != 0` so that the line cannot show in play even if a scene draws such a texture.

## Not found

No RDRAM field that holds the alpha was pinned down. A scan of all RDRAM over tasks 1040 to 1136 for words, halfwords and bytes (and floats) that change in the same linear steps found only unrelated or modular noise. The page therefore reads the alpha from the display list the interpreter already produces for each picture (`logoAlpha` in `web/title-edition.ts`), which is also what the player sees, and also what the smoothing path draws between game frames. The SETTIMG addresses of the subtitle texture were not traced: the title's lists reach the texture draws through segment-addressed sub-lists the scan did not follow.

## Where the line goes

The subtitle's fill pass ends at x 247, y 134. `web/title-edition.ts` right-aligns "FRAIDOUX EDITION" at x 246 with its middle at y 147.5, in a 320x240 canvas laid over the picture (the same size as the game's picture, so scaled and filtered with it).
