// Boots the recompiled game in the page and feeds each graphics task it submits to the renderer.
import { Synth } from '../tools/audio/synth.ts';
import { runDisplayList } from '../tools/gfx/c-dl.ts';
import { FrameProfiler } from '../tools/gfx/profile.ts';
import { FULL_SMOOTHING, finalColorImage, SmoothFrames, smoothFraction, type SmoothCore, type SmoothTuning } from '../tools/gfx/smooth.ts';
import { shownFramebuffer } from '../tools/gfx/vi.ts';
import { RDRAM_SIZE, startModule } from '../tools/runtime/instance.ts';
import type { AudioSink } from './audio.ts';
import type { Hz } from './mode.ts';
import type { PadState } from './input.ts';
import { lightSources } from './point-lights.ts';
import type { Renderer } from './renderer.ts';
import type { SaveMemory } from './saves.ts';
import { compress, decompress, type StateSource } from './savestate.ts';
import { mark } from './timing.ts';
import { MODULE_URL, type WasmBuild } from './wasm.ts';
import { loadState, saveState, type StateCore } from '../tools/runtime/snapshot.ts';

interface WebCore extends StateCore {
  _oot_reset(): void;
  _oot_rd32(addr: number): number;
  _gfx_set_pixel_lighting(mode: number): void;
  _gfx_set_camera_output(on: number): void;
}

export interface Game {
  /** Sets controller 1 for the frames that follow. */
  setPad(pad: PadState): void;
  /** The save memory the game reads and writes. */
  saveMemory: SaveMemory;
  /** Save states of the game; capture and apply only between two frames. */
  states: StateSource;
  /** The guest memory, big-endian, indexed by physical address; valid until the next frame. */
  ram(): Uint8Array;
  /** Starts the game over on the same cartridge, as the console's reset does; the save memory is kept. Call between frames. */
  reset(): void;
  /** Runs the game for one video frame. Rejects with the game's own message when it stops. */
  frame(): Promise<void>;
  /** Address of the colour image the video interface shows. */
  framebuffer(): number;
  /** Times the phases of each game frame; see FrameProfiler. */
  profiler: FrameProfiler;
  /**
   * Turns smoothing on or off. While on, graphics tasks are kept instead of drawn and `drawSmooth` draws the pictures between
   * them; turning it off drops what was kept, and tasks are drawn as they come.
   */
  setSmooth(on: boolean): void;
  /** Sets how much of the motion is shown; see SmoothTuning. */
  tuneSmooth(tuning: SmoothTuning): void;
  /**
   * Draws the picture `sinceFrame` of a video frame (0 to 1) after the last video frame that ran, between the last two game
   * frames, and returns the colour image to show; null when no game frame is kept. Does the work once for pictures that do not change.
   */
  drawSmooth(sinceFrame: number): number | null;
  /** What smoothing matched between the last two game frames; null until there are two. */
  smoothInfo(): SmoothInfo | null;
  info(): { frames: number; retraces: number; gfxTasks: number; audioTasks: number; idle: boolean; renderError: string; audioError: string };
}

export interface SmoothInfo {
  /** Matrices of 3D work in the last game frame, and how many of them were found in the one before. */
  threeD: number;
  matched: number;
  /** The picture is the game frame as it is: the camera cut, or the frames could not be paired. */
  cut: boolean;
  /** Share of the frame's vertices the game wrote itself. */
  rewritten: number;
}

export async function startGame(rom: Uint8Array, renderer: Renderer, audio: AudioSink, wasm: WasmBuild, moduleUrl = MODULE_URL, hz: Hz = 50): Promise<Game> {
  let renderError = '';
  let audioError = '';
  const synth = new Synth();
  const profiler = new FrameProfiler();
  renderer.onGpuTime = (ms) => profiler.addGpu(ms);
  let smoothing = false;
  let frames: SmoothFrames | null = null;
  // Video frames run so far, the ones that ran the last two kept game frames, and which picture was drawn last.
  let videoFrames = 0;
  let keptAt = 0, keptBefore = 0;
  let serial = 0;
  let tuning = FULL_SMOOTHING;
  let drawn = '';
  let lastShown: number | null = null;
  // 1: lit triangles come with normals and light sets for per-pixel shading (runtime/gfx/gfx.h).
  const useLighting = () => {
    mod._gfx_set_pixel_lighting(renderer.options.lightingMode === 'pixel' ? 1 : 0);
    // Point lights: the interpreter reports the camera, and the torches of the scene come from the actor lists.
    const lights = renderer.options.pointLights;
    mod._gfx_set_camera_output(lights ? 1 : 0);
    if (lights) renderer.setPointSources(lightSources((addr) => mod._oot_rd32(addr) >>> 0, renderer.markedLightIds));
  };
  const guestRam = () => mod.HEAPU8.subarray(mod._oot_rdram(), mod._oot_rdram() + RDRAM_SIZE);
  // The module's start-up promise never settles when the hook below fails, so the failure is raced against it.
  let failInstantiation!: (err: unknown) => void;
  const instantiationFailed = new Promise<never>((_, reject) => (failInstantiation = reject));
  const started = startModule<WebCore & SmoothCore>(moduleUrl, rom, {
    instantiateWasm: (imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance) => void) => {
      wasm.module
        .then((module) => WebAssembly.instantiate(module, imports))
        .then((instance) => {
          done(instance);
          mark('instantiated');
        })
        .catch(failInstantiation);
      return {};
    },
    onGfxTask: (data: number) => profiler.hook(() => {
      try {
        if (smoothing) {
          const t0 = performance.now();
          frames!.push(data);
          keptBefore = keptAt;
          keptAt = videoFrames;
          serial++;
          profiler.addDisplayList(performance.now() - t0);
          profiler.taskDone();
          return;
        }
        const t0 = performance.now();
        useLighting();
        const result = runDisplayList(mod, data);
        const t1 = performance.now();
        renderer.drawTask(result, guestRam());
        profiler.addDisplayList(t1 - t0);
        profiler.addSubmit(performance.now() - t1, renderer.stats.drawCalls);
      } catch (err) {
        renderError = err instanceof Error ? err.message : String(err);
        console.error(err);
      }
      profiler.taskDone();
    }),
    onAudioTask: (data: number, size: number, _microcode: number, microcodeData: number) => profiler.hook(() => {
      try {
        synth.run(guestRam(), { list: data & 0x1fffffff, size, dataSegment: microcodeData & 0x1fffffff });
      } catch (err) {
        audioError = err instanceof Error ? err.message : String(err);
        console.error(err);
      }
    }),
    onAiBuffer: (addr: number, length: number, hz: number) => profiler.hook(() => {
      const at = addr & 0x7fffff;
      audio.push(guestRam().slice(at, at + length), hz);
    }),
  }, hz);
  const mod = await Promise.race([started, instantiationFailed]);
  frames = new SmoothFrames(mod);
  const view = () => new DataView(mod.HEAPU8.buffer, mod._oot_rdram(), RDRAM_SIZE);
  const sram = () => mod.HEAPU8.subarray(mod._oot_sram(), mod._oot_sram() + mod._oot_sram_size());
  return {
    profiler,
    ram: guestRam,
    reset: () => mod._oot_reset(),
    setPad: (pad) => mod._oot_pad_set(0, pad.buttons, pad.x, pad.y),
    saveMemory: {
      read: () => sram().slice(),
      write: (bytes) => sram().set(bytes.subarray(0, mod._oot_sram_size())),
      takeIfDirty: () => (mod._oot_sram_take_dirty() ? sram().slice() : null),
    },
    // The kept frames are display data, not part of a state; one loaded makes them stale.
    states: {
      capture: () => compress(saveState(mod)),
      apply: async (data) => {
        await loadState(mod, await decompress(data));
        frames!.forget();
      },
    },
    setSmooth(on) {
      if (on === smoothing) return;
      smoothing = on;
      drawn = '';
      if (!on) frames!.forget();
    },
    tuneSmooth(next) {
      tuning = next;
    },
    drawSmooth(sinceFrame) {
      if (!smoothing || !frames!.ready) return null;
      const t = smoothFraction(videoFrames + sinceFrame, keptAt, keptBefore, tuning);
      const plan = frames!.plan;
      // With nothing to move the picture is the same all game frame long.
      const still = !plan || plan.stats.cut || plan.entries.length === 0 || t >= 1;
      const token = `${serial} ${still ? 'still' : t}`;
      if (token === drawn) return lastShown;
      const t0 = performance.now();
      try {
        useLighting();
        const result = frames!.at(t);
        const t1 = performance.now();
        renderer.drawTask(result);
        profiler.addDisplayList(t1 - t0);
        profiler.addSubmit(performance.now() - t1, renderer.stats.drawCalls);
        lastShown = finalColorImage(result);
      } catch (err) {
        renderError = err instanceof Error ? err.message : String(err);
        console.error(err);
        lastShown = null;
      }
      drawn = token;
      return lastShown;
    },
    smoothInfo() {
      const stats = frames!.stats;
      return stats ? { threeD: stats.threeD, matched: stats.matched, cut: stats.cut, rewritten: frames!.rewritten } : null;
    },
    async frame() {
      videoFrames++;
      try {
        await profiler.frame(() => mod._oot_frame());
      } catch (err) {
        const message = mod.UTF8ToString(mod._oot_fatal_message());
        throw new Error(message || (err instanceof Error ? err.message : String(err)), { cause: err });
      }
    },
    framebuffer: () => shownFramebuffer((addr) => view().getUint32(addr & 0x1fffffff)),
    info: () => ({ frames: mod._oot_frames(), retraces: mod._oot_retraces(), gfxTasks: mod._oot_gfx_tasks(), audioTasks: mod._oot_audio_tasks(), idle: mod._oot_idle() !== 0, renderError, audioError }),
  };
}
