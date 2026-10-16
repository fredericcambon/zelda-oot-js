// Loads the built game into this process and steps it one video frame at a time.
import { shownFramebuffer } from '../gfx/vi.ts';
import { RDRAM_SIZE, startModule } from '../runtime/instance.ts';
import { captureMemory, restoreMemory, type MemorySnapshot, type SnapshotCore } from '../runtime/snapshot.ts';

const OS_ALLTHREADS = 0x8000685c;
const OS_SENTINEL = 0x80006850;
const TH_NEXT_ALL = 0x0c;
const TH_PRI = 0x04;
const TH_ID = 0x14;
const TH_ENTRY = 0x11c;

interface OotModule extends SnapshotCore {
  _oot_jpeg_tasks(): number;
  _oot_rd32(addr: number): number;
  _oot_trace_count?(): number;
  _oot_trace_at?(back: number): number;
  _oot_rsp_task_kinds(): number;
  _oot_rsp_task_kind(i: number, field: number): number;
  _oot_cov_enabled(): number;
  _oot_cov_functions(): number;
  _oot_cov_os_count(): number;
  _oot_cov_os_addr(i: number): number;
  _oot_cov_os_hits(i: number): number;
  _oot_cov_outside_count(): number;
  _oot_cov_outside(i: number, field: number): number;
}

/** Bytes of address space, from 0x80000000, that the function bitmap of a coverage build spans (COVERAGE_WINDOW in runtime/cov.c). */
const COVERAGE_WINDOW = 0x1000000;

/** What a coverage build (`npm run port -- --coverage`) saw run so far. */
export interface CoverageSnapshot {
  /** Entry addresses of the recompiled functions that ran (overlay functions at their link address). */
  functions: number[];
  /** Calls of each OS routine the runtime replaces, by routine address; routines never called are left out. */
  osCalls: Map<number, number>;
  /** Guest addresses beyond RDRAM that the code read or wrote, with the number of accesses and the function entered last at the first access. */
  outsideRdram: { addr: number; hits: number; function: number }[];
}

export interface FrameResult {
  frame: number;
  alive: boolean;
  retraces: number;
  gfxTasks: number;
  audioTasks: number;
  jpegTasks: number;
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

/** An audio command list as the game submitted it. */
export interface AudioTask {
  /** Start and size in bytes of the command list. */
  data: number;
  size: number;
  /** Addresses of the microcode's text and of its data segment, which holds the resampler's filter table. */
  microcode: number;
  microcodeData: number;
  ram: Uint8Array;
}

/** A buffer of 16-bit stereo frames the game queued to the audio interface. */
export interface AiBuffer {
  addr: number;
  length: number;
  /** Sample rate in Hz. */
  hz: number;
  ram: Uint8Array;
}

export interface BootOptions {
  /** Called synchronously when the game starts a graphics task, before it can touch the memory again. */
  onGfxTask?: (task: GfxTask) => void;
  /** Called synchronously when the game starts an audio task. */
  onAudioTask?: (task: AudioTask) => void;
  /** Called synchronously when the game queues a buffer to the audio interface. */
  onAiBuffer?: (buffer: AiBuffer) => void;
}

export interface Game {
  frame(): Promise<FrameResult>;
  stats(): string;
  /** The last `n` recompiled functions entered, newest first; empty unless the build records calls (`npm run port -- --trace-calls`). */
  lastCalls(n: number): string[];
  /** Address of the colour image the video interface shows; 0 when the screen is blanked. */
  framebuffer(): number;
  /** Sets controller 1 for the frames that follow. */
  setPad(buttons: number, x?: number, y?: number): void;
  /** Reads a word of guest memory. */
  rd32(addr: number): number;
  /** The guest memory, big-endian, indexed by physical address; a view that stays valid only until the next frame. */
  ram(): Uint8Array;
  /** A copy of the save memory. */
  readSave(): Uint8Array;
  /** Replaces the start of the save memory; call before the first frame. */
  writeSave(bytes: Uint8Array): void;
  /** Whether the game wrote the save memory since the last call. */
  takeSaveDirty(): boolean;
  /** The kinds of RSP task submitted so far (type and microcode), with their counts. */
  rspTasks(): { type: number; ucode: number; count: number }[];
  /** The coverage counters, or undefined when the module is not a coverage build. */
  coverage(): CoverageSnapshot | undefined;
  /** The complete state of the game; call between frames. */
  snapshot(): MemorySnapshot;
  /** Puts back a state taken from a game booted from the same build and cartridge image; the save memory is kept. */
  restore(state: MemorySnapshot): void;
}

export async function bootGame(moduleUrl: string, rom: Uint8Array, options: BootOptions = {}): Promise<Game> {
  const guestRam = () => mod.HEAPU8.subarray(mod._oot_rdram(), mod._oot_rdram() + RDRAM_SIZE);
  const mod = await startModule<OotModule>(moduleUrl, rom, {
    onGfxTask: (data: number, size: number, task: number) => {
      options.onGfxTask?.({ task: task >>> 0, data: data >>> 0, size: size >>> 0, ram: guestRam() });
    },
    onAudioTask: (data: number, size: number, microcode: number, microcodeData: number) =>
      options.onAudioTask?.({ data: data >>> 0, size: size >>> 0, microcode: microcode >>> 0, microcodeData: microcodeData >>> 0, ram: guestRam() }),
    onAiBuffer: (addr: number, length: number, hz: number) => options.onAiBuffer?.({ addr: addr >>> 0, length: length >>> 0, hz: hz >>> 0, ram: guestRam() }),
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
        audioTasks: mod._oot_audio_tasks(), jpegTasks: mod._oot_jpeg_tasks(), newThreads, fatal,
      };
    },
    framebuffer: () => shownFramebuffer(rd32),
    setPad: (buttons, x = 0, y = 0) => mod._oot_pad_set(0, buttons, x, y),
    rd32,
    ram: () => mod.HEAPU8.subarray(mod._oot_rdram(), mod._oot_rdram() + RDRAM_SIZE),
    readSave: () => mod.HEAPU8.slice(mod._oot_sram(), mod._oot_sram() + mod._oot_sram_size()),
    writeSave: (bytes) => mod.HEAPU8.set(bytes.subarray(0, mod._oot_sram_size()), mod._oot_sram()),
    takeSaveDirty: () => mod._oot_sram_take_dirty() !== 0,
    rspTasks: () => Array.from({ length: mod._oot_rsp_task_kinds() }, (_, i) => ({
      type: mod._oot_rsp_task_kind(i, 0), ucode: mod._oot_rsp_task_kind(i, 1) >>> 0, count: mod._oot_rsp_task_kind(i, 2),
    })),
    coverage() {
      if (!mod._oot_cov_enabled?.()) return undefined;
      const bitmap = mod.HEAPU8.subarray(mod._oot_cov_functions(), mod._oot_cov_functions() + COVERAGE_WINDOW / 32);
      const functions: number[] = [];
      bitmap.forEach((byte, i) => {
        for (let bit = 0; byte !== 0 && bit < 8; bit++) if (byte & (1 << bit)) functions.push((0x80000000 + (i * 8 + bit) * 4) >>> 0);
      });
      const osCalls = new Map<number, number>();
      for (let i = 0; i < mod._oot_cov_os_count(); i++) if (mod._oot_cov_os_hits(i) > 0) osCalls.set(mod._oot_cov_os_addr(i) >>> 0, mod._oot_cov_os_hits(i));
      const outsideRdram = Array.from({ length: mod._oot_cov_outside_count() }, (_, i) => ({
        addr: mod._oot_cov_outside(i, 0) >>> 0, hits: mod._oot_cov_outside(i, 1), function: mod._oot_cov_outside(i, 2) >>> 0,
      }));
      return { functions, osCalls, outsideRdram };
    },
    snapshot: () => captureMemory(mod),
    restore: (state) => restoreMemory(mod, state),
    lastCalls(n) {
      const total = mod._oot_trace_count?.() ?? 0;
      return Array.from({ length: Math.min(n, total) }, (_, k) => `0x${hex(mod._oot_trace_at!(k))}`);
    },
    stats: () => `${mod._oot_retraces()} retraces, ${mod._oot_gfx_tasks()} graphics tasks, ${mod._oot_audio_tasks()} audio tasks, ${seen.size} threads`,
  };
}
