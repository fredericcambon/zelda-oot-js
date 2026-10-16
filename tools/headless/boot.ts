// Loads the built game into this process and steps it one video frame at a time.
import { shownFramebuffer } from '../gfx/vi.ts';
import { RDRAM_SIZE, startModule, type OotCore } from '../runtime/instance.ts';

const OS_ALLTHREADS = 0x8000685c;
const OS_SENTINEL = 0x80006850;
const TH_NEXT_ALL = 0x0c;
const TH_PRI = 0x04;
const TH_ID = 0x14;
const TH_ENTRY = 0x11c;

interface OotModule extends OotCore {
  _oot_audio_tasks(): number;
  _oot_rd32(addr: number): number;
  _oot_trace_count?(): number;
  _oot_trace_at?(back: number): number;
}

export interface FrameResult {
  frame: number;
  alive: boolean;
  retraces: number;
  gfxTasks: number;
  audioTasks: number;
  newThreads: string[];
  /** One line per thread: address, id, priority, state and the queue it waits on. */
  threadStates: string[];
  fatal?: string;
}

/** A graphics task as the game submitted it; `ram` is the guest memory at that moment, big-endian, indexed by physical address. */
export interface GfxTask {
  /** Address of the task record. */
  task: number;
  /** Start and size in bytes of the display list. */
  data: number;
  size: number;
  ram: Uint8Array;
}

export interface BootOptions {
  /** Called synchronously when the game starts a graphics task, before it can touch the memory again. */
  onGfxTask?: (task: GfxTask) => void;
}

export interface Game {
  frame(): Promise<FrameResult>;
  stats(): string;
  /** The last `n` recompiled functions entered, newest first; empty unless the build records calls (`npm run port -- --trace-calls`). */
  lastCalls(n: number): string[];
  /** Address of the colour image the video interface shows; 0 when the screen is blanked. */
  framebuffer(): number;
}

export async function bootGame(moduleUrl: string, rom: Uint8Array, options: BootOptions = {}): Promise<Game> {
  const mod = await startModule<OotModule>(moduleUrl, rom, {
    onGfxTask: (data: number, size: number, task: number) => {
      data >>>= 0; size >>>= 0; task >>>= 0;
      const ram = mod.HEAPU8.subarray(mod._oot_rdram(), mod._oot_rdram() + RDRAM_SIZE);
      options.onGfxTask?.({ task, data, size, ram });
    },
  });

  const rd32 = (addr: number) => mod._oot_rd32(addr) >>> 0;
  const seen = new Set<number>();
  const threadList = (): number[] => {
    const out: number[] = [];
    for (let t = rd32(OS_ALLTHREADS); t !== 0 && t !== OS_SENTINEL && out.length < 64; t = rd32(t + TH_NEXT_ALL)) out.push(t);
    return out;
  };
  const hex = (n: number) => (n >>> 0).toString(16);

  return {
    async frame() {
      let alive = true;
      let fatal: string | undefined;
      try {
        await mod._oot_frame();
        alive = !mod._oot_idle();
      } catch (err) {
        fatal = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
        const message = mod.UTF8ToString(mod._oot_fatal_message());
        if (message) fatal = message;
      }
      const newThreads: string[] = [];
      for (const t of threadList()) {
        if (seen.has(t)) continue;
        seen.add(t);
        newThreads.push(`0x${hex(t)} id=${rd32(t + TH_ID)} pri=${rd32(t + TH_PRI)} entry=0x${hex(rd32(t + TH_ENTRY))}`);
      }
      const threadStates = threadList().map((t) => {
        const state = rd32(t + 0x10) >>> 16;
        return `0x${hex(t)} id=${rd32(t + TH_ID)} pri=${rd32(t + TH_PRI) | 0} state=${state} queue=0x${hex(rd32(t + 8))}`;
      });
      return {
        threadStates, frame: mod._oot_frames(), alive, retraces: mod._oot_retraces(), gfxTasks: mod._oot_gfx_tasks(),
        audioTasks: mod._oot_audio_tasks(), newThreads, fatal,
      };
    },
    framebuffer: () => shownFramebuffer(rd32),
    lastCalls(n) {
      const total = mod._oot_trace_count?.() ?? 0;
      return Array.from({ length: Math.min(n, total) }, (_, k) => `0x${hex(mod._oot_trace_at!(k))}`);
    },
    stats: () => `${mod._oot_retraces()} retraces, ${mod._oot_gfx_tasks()} graphics tasks, ${mod._oot_audio_tasks()} audio tasks, ${seen.size} threads`,
  };
}
