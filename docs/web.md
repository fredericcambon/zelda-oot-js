# Browser shell and renderer

`web/` is the page that runs the built game (`dist/oot.js`, produced by `npm run port`). `npm run dev -- --port <p> --strictPort` serves it and serves `dist/oot.js` and `dist/oot.wasm` at the site root; `npm run build` writes `dist/web/` and copies the two files and `rom/` beside the page.

- **ROM.** The page never asks for a ROM. `npm run port -- --rom <path>` (which checks the SHA-1) writes `dist/rom/`: the header, every file of the file table as stored (compressed where the ROM stores it compressed), the file table and the gaps as separate pieces, plus `index.json` mapping ROM ranges to pieces (`tools/rom/pieces.ts`). The page fetches the index and all pieces before boot (progress line in the status text), rebuilds the cartridge image in memory and hands it to the runtime. `web/no-rom-file.test.ts` checks that the sources name no ROM file and use no file input or file-reading API.
- **Frame loop.** A `requestAnimationFrame` loop accumulates time and calls `oot_frame` once per 20 ms (50 Hz, at most three catch-up frames). After the frames of an iteration it shows the colour image the video interface points at, read from the game's current `OSViContext` (`tools/gfx/vi.ts`); a blanked screen or an address nothing was drawn to shows black. A buffer the game is still drawing into is never shown, because the game only hands it to the video interface after its task.
- **Graphics tasks.** `Module.onGfxTask` runs `DisplayListInterpreter` over the memory as the game left it and hands the batches to `Renderer`. Colour images and the depth buffer have the size of the canvas as displayed, a whole multiple (1 to 4) of 320×240, so edges and bilinear texture filtering are not magnified from a small target; N switches to native 320×240 shown with hard pixels. The game never reads the colour images back through the page (the display lists are interpreted from guest memory), so resolution does not affect any readback.
- **Colour and depth images.** Each colour image address the game draws into (`SETCIMG`) is a 320×240 texture, so double buffering works; there is one depth buffer, cleared by the fill rectangles the game draws while `SETCIMG` names the depth image address.
- **Debug overlay.** F3 toggles it: frame and task counters, command, batch and triangle counts of the last task, unknown commands and interpreter problems, program and texture counts. C cycles face culling (normal, swapped, off), N toggles native resolution, and `#debug` on the URL opens the overlay.

## Shaders

`web/shader.ts` builds one GLSL ES 3.00 fragment shader per `ShaderSpec`: the combiner inputs of both cycles, cycle type, filter mode, alpha compare, fog in shade alpha, and the blender selectors. Colours, tile sizes, masks and shifts are uniforms. Input selector numbering is the one `decodeCombine` already extracts; the meaning of each code, the blender selectors and the other-mode bit positions are from the RDP descriptions on n64brew.dev.

- Blender: `(p·a + m·b) / (a + b)`. A cycle that does not read the framebuffer is computed in the shader (this is how fog works). The last cycle, when it reads the framebuffer and the force-blend bit is set, outputs `p` with weight `a / (a + b)` in alpha and the GL blend unit does the rest; the framebuffer alpha is taken as 1.
- Texture sampling: tile origin subtracted, shift, clamp, mirror and mask in the shader; 3-point bilinear when the filter bits are not zero.
- Depth: enabled by the geometry mode's z-buffer bit, compare and update by the other-mode bits, decal mode by a polygon offset.
- Fill rectangles in fill mode clear the rectangle (inclusive corners); in the other cycle types they draw through the combiner.

## Not verified against footage

The ROM was not run in a browser for this work, so these are open:
- front/back face orientation (`C` flips it);
- whether the second cycle's first texel input is the first cycle's second lookup;
- decal depth tolerance, coverage-based edge antialiasing (ignored), dithering (ignored), noise input (0.5).
