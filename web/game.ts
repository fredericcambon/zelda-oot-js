// Boots the recompiled game in the page and feeds each graphics task it submits to the renderer.
import { Synth } from '../tools/audio/synth.ts';
import { DisplayListInterpreter } from '../tools/gfx/dl.ts';
import { shownFramebuffer } from '../tools/gfx/vi.ts';
import { RDRAM_SIZE, startModule } from '../tools/runtime/instance.ts';
import type { AudioSink } from './audio.ts';
import type { Hz } from './mode.ts';
import type { PadState } from './input.ts';
import type { Renderer } from './renderer.ts';
import type { SaveMemory } from './saves.ts';
import { buildIdOf, compress, decompress, type StateSource } from './savestate.ts';
import { captureMemory, decodeMemory, encodeMemory, restoreMemory, type SnapshotCore } from '../tools/runtime/snapshot.ts';

export interface Game {
  /** Sets controller 1 for the frames that follow. */
  setPad(pad: PadState): void;
  /** The save memory the game reads and writes. */
  saveMemory: SaveMemory;
  /** Save states of the game; capture and apply only between two frames. */
  states: StateSource;
  /** Identifies the game module build (the hash of its wasm file). */
  buildId(): Promise<string>;
  /** Runs the game for one video frame. Rejects with the game's own message when it stops. */
  frame(): Promise<void>;
  /** Address of the colour image the video interface shows. */
  framebuffer(): number;
  info(): { frames: number; retraces: number; gfxTasks: number; audioTasks: number; idle: boolean; renderError: string; audioError: string };
}

export async function startGame(rom: Uint8Array, renderer: Renderer, audio: AudioSink, moduleUrl = '/oot.js', hz: Hz = 50): Promise<Game> {
  let renderError = '';
  let audioError = '';
  const synth = new Synth();
  const guestRam = () => mod.HEAPU8.subarray(mod._oot_rdram(), mod._oot_rdram() + RDRAM_SIZE);
  const mod = await startModule<SnapshotCore>(moduleUrl, rom, {
    onGfxTask: (data: number) => {
      try {
        renderer.drawTask(new DisplayListInterpreter().run(guestRam(), data >>> 0));
      } catch (err) {
        renderError = err instanceof Error ? err.message : String(err);
        console.error(err);
      }
    },
    onAudioTask: (data: number, size: number, _microcode: number, microcodeData: number) => {
      try {
        synth.run(guestRam(), { list: data & 0x1fffffff, size, dataSegment: microcodeData & 0x1fffffff });
      } catch (err) {
        audioError = err instanceof Error ? err.message : String(err);
        console.error(err);
      }
    },
    onAiBuffer: (addr: number, length: number, hz: number) => {
      const at = addr & 0x7fffff;
      audio.push(guestRam().slice(at, at + length), hz);
    },
  }, hz);
  const view = () => new DataView(mod.HEAPU8.buffer, mod._oot_rdram(), RDRAM_SIZE);
  const sram = () => mod.HEAPU8.subarray(mod._oot_sram(), mod._oot_sram() + mod._oot_sram_size());
  return {
    setPad: (pad) => mod._oot_pad_set(0, pad.buttons, pad.x, pad.y),
    saveMemory: {
      write: (bytes) => sram().set(bytes.subarray(0, mod._oot_sram_size())),
      takeIfDirty: () => (mod._oot_sram_take_dirty() ? sram().slice() : null),
    },
    states: {
      capture: () => compress(encodeMemory(captureMemory(mod))),
      apply: async (data) => restoreMemory(mod, decodeMemory(await decompress(data))),
    },
    buildId: async () => {
      const wasmUrl = moduleUrl.replace(/\.js$/, '.wasm');
      return buildIdOf(await (await fetch(wasmUrl)).arrayBuffer());
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
    info: () => ({ frames: mod._oot_frames(), retraces: mod._oot_retraces(), gfxTasks: mod._oot_gfx_tasks(), audioTasks: mod._oot_audio_tasks(), idle: mod._oot_idle() !== 0, renderError, audioError }),
  };
}
