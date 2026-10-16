// Boots the recompiled game in the page and feeds each graphics task it submits to the renderer.
import { DisplayListInterpreter } from '../tools/gfx/dl.ts';
import { shownFramebuffer } from '../tools/gfx/vi.ts';
import { RDRAM_SIZE, startModule, type OotCore } from '../tools/runtime/instance.ts';
import type { PadState } from './input.ts';
import type { Renderer } from './renderer.ts';
import type { SaveMemory } from './saves.ts';


export interface Game {
  /** Sets controller 1 for the frames that follow. */
  setPad(pad: PadState): void;
  /** The save memory the game reads and writes. */
  saveMemory: SaveMemory;
  /** Runs the game for one video frame. Rejects with the game's own message when it stops. */
  frame(): Promise<void>;
  /** Address of the colour image the video interface shows. */
  framebuffer(): number;
  info(): { frames: number; retraces: number; gfxTasks: number; idle: boolean; renderError: string };
}

export async function startGame(rom: Uint8Array, renderer: Renderer, moduleUrl = '/oot.js'): Promise<Game> {
  let renderError = '';
  const mod = await startModule<OotCore>(moduleUrl, rom, {
    onGfxTask: (data: number) => {
      try {
        const ram = mod.HEAPU8.subarray(mod._oot_rdram(), mod._oot_rdram() + RDRAM_SIZE);
        renderer.drawTask(new DisplayListInterpreter().run(ram, data >>> 0));
      } catch (err) {
        renderError = err instanceof Error ? err.message : String(err);
        console.error(err);
      }
    },
  });
  const view = () => new DataView(mod.HEAPU8.buffer, mod._oot_rdram(), RDRAM_SIZE);
  const sram = () => mod.HEAPU8.subarray(mod._oot_sram(), mod._oot_sram() + mod._oot_sram_size());
  return {
    setPad: (pad) => mod._oot_pad_set(0, pad.buttons, pad.x, pad.y),
    saveMemory: {
      write: (bytes) => sram().set(bytes.subarray(0, mod._oot_sram_size())),
      takeIfDirty: () => (mod._oot_sram_take_dirty() ? sram().slice() : null),
    },
    async frame() {
      try {
        await mod._oot_frame();
      } catch (err) {
        const message = mod.UTF8ToString(mod._oot_fatal_message());
        throw new Error(message || (err instanceof Error ? err.message : String(err)), { cause: err });
      }
    },
    framebuffer: () => shownFramebuffer((addr) => view().getUint32(addr & 0x1fffffff)),
    info: () => ({ frames: mod._oot_frames(), retraces: mod._oot_retraces(), gfxTasks: mod._oot_gfx_tasks(), idle: mod._oot_idle() !== 0, renderError }),
  };
}
