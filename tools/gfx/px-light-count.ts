// `OOT_ROM=<rom> npx tsx tools/gfx/px-light-count.ts [--saves out/px-light/saves] [--frames 20]`: loads the states made by px-light-states.ts and counts, over
// the graphics tasks of the frames that follow, the triangles lit per pixel, left on the vertex path and with normals against their face.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { decompressState } from '../runtime/snapshot.ts';
import { loadBase } from '../recomp/test-base.ts';
import { bootGame } from '../headless/boot.ts';
import { sharedGfxModule, sharedInterpreter } from './c-dl-node.ts';

const { values } = parseArgs({ options: { saves: { type: 'string', default: 'out/px-light/saves' }, frames: { type: 'string', default: '20' } } });
const core = await sharedGfxModule();
const interpreter = await sharedInterpreter();
for (const [name, slot] of [['forest', 1], ['house', 2]] as const) {
  const sum = { tasks: 0, triangles: 0, lit: 0, reversed: 0, mixed: 0, vertexPath: 0, batchesVertex: 0, batchesPixel: 0, litBatches: 0, vertices: 0 };
  const base = loadBase();
  const game = await bootGame(base.moduleUrl, base.cartridge(), {
    onGfxTask: (t) => {
      for (const mode of [0, 1]) {
        core._gfx_set_pixel_lighting!(mode);
        const r = interpreter.run(t.ram, t.data);
        const tris = r.batches.reduce((n, b) => n + (b.kind === 'triangles' ? b.positions.length / 12 : 0), 0);
        if (mode === 0) {
          sum.batchesVertex += r.batches.length;
          sum.tasks++;
          sum.triangles += tris;
        } else if (r.lighting) {
          sum.batchesPixel += r.batches.length;
          sum.lit += r.lighting.lit;
          sum.reversed += r.lighting.reversed;
          sum.mixed += r.lighting.mixed;
          sum.vertexPath += r.lighting.vertexPath;
          sum.litBatches += r.batches.filter((b) => b.kind === 'triangles' && b.lights).length;
        }
      }
      core._gfx_set_pixel_lighting!(0);
    },
  });
  await game.loadState(await decompressState(readFileSync(join(values.saves!, `state-${slot}.bin`))));
  for (let i = 0; i < Number(values.frames); i++) await game.frame();
  console.log(name, JSON.stringify(sum));
}
