// Boots the recompiled game in the page and feeds each graphics task it submits to the renderer.
import { DisplayListInterpreter } from '../tools/gfx/dl.ts';
import type { Renderer } from './renderer.ts';

const RDRAM_SIZE = 0x800000;

interface OotModule {
  HEAPU8: Uint8Array;
  _malloc(n: number): number;
  _oot_boot(rom: number, size: number): void;
  _oot_frame(): void | Promise<void>;
  _oot_idle(): number;
  _oot_frames(): number;
  _oot_gfx_tasks(): number;
  _oot_retraces(): number;
  _oot_rdram(): number;
  _oot_vi_framebuffer?(): number;
  _oot_fatal_message(): number;
  UTF8ToString(ptr: number): string;
}

export interface Game {
  /** Runs the game for one video frame. Rejects with the game's own message when it stops. */
  frame(): Promise<void>;
  /** Address of the colour image the video interface shows. */
  framebuffer(): number;
  info(): { frames: number; retraces: number; gfxTasks: number; idle: boolean; renderError: string };
}

export async function startGame(rom: Uint8Array, renderer: Renderer, moduleUrl = '/oot.js'): Promise<Game> {
  const factory = (await import(/* @vite-ignore */ moduleUrl)).default as (opts?: object) => Promise<OotModule>;
  let renderError = '';
  const mod = await factory({
    print: () => {},
    printErr: (m: string) => console.error(m),
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
  const copy = mod._malloc(rom.length);
  mod.HEAPU8.set(rom, copy);
  mod._oot_boot(copy, rom.length);
  return {
    async frame() {
      try {
        await mod._oot_frame();
      } catch (err) {
        const message = mod.UTF8ToString(mod._oot_fatal_message());
        throw new Error(message || (err instanceof Error ? err.message : String(err)), { cause: err });
      }
    },
    framebuffer: () => (mod._oot_vi_framebuffer?.() ?? 0) >>> 0,
    info: () => ({ frames: mod._oot_frames(), retraces: mod._oot_retraces(), gfxTasks: mod._oot_gfx_tasks(), idle: mod._oot_idle() !== 0, renderError }),
  };
}
