// The description of the guest threads that the runtime writes at a frame boundary (rt_threads_describe in runtime/sched.c)
// and rebuilds them from (rt_threads_rebuild). It names no address of the build that wrote it: a thread is its registers,
// the call sites its host frames stand for, and the place it waits at. All words are little-endian 32-bit values.

export const THREADS_MAGIC = 0x44524854; // "THRD"

/** A call in progress, named by the ROM's function and call address. */
export interface SiteFrame {
  kind: 'site';
  /** Index of the recompiled image: the boot code, the main code, a segment or an overlay (oot_images). */
  image: number;
  /** Entry address of the function, as linked. */
  entry: number;
  /** Address of the call instruction, as linked; the address just past the function for a fall into the next one. */
  site: number;
}

/** A runtime routine that called recompiled code and keeps its own values in a frame (RT_FRAME_* in runtime/rt.h). */
export interface RuntimeFrame {
  kind: 'runtime';
  id: number;
  payload: [number, number];
}

export type ThreadFrame = SiteFrame | RuntimeFrame;

/** The registers a guest program sees. */
export interface GuestRegisters {
  r: bigint[];
  hi: bigint;
  lo: bigint;
  llbit: number;
  f: bigint[];
  fcsr: number;
  fir: number;
  fr: number;
}

export interface DescribedThread {
  /** Position in the runtime's thread table. */
  slot: number;
  /** Address of the OSThread record. */
  addr: number;
  /** Entry function of the thread. */
  entry: number;
  started: boolean;
  /** The idle loop, which is not resumed until its priority rises. */
  parked: boolean;
  registers: GuestRegisters;
  /** Where the thread waits (BS_* in runtime/rt.h); 0 for a thread that has not started. */
  blockingSite: number;
  /** The call chain, outermost first. */
  frames: ThreadFrame[];
}

export interface ThreadsDescription {
  /** The OSThread record of the running thread; 0 between two frames. */
  running: number;
  /** COP0 Status and the interrupt mask the runtime keeps. */
  status: number;
  intMask: number;
  threads: DescribedThread[];
}

const FRAME_SITE = 0;
const FRAME_RUNTIME = 1;

/** Reads a description; throws when it is cut short or does not start with the magic number. */
export function parseThreads(bytes: Uint8Array): ThreadsDescription {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const u32 = () => {
    if (at + 4 > bytes.length) throw new Error('the thread description is cut short');
    const v = view.getUint32(at, true);
    at += 4;
    return v;
  };
  const u64 = () => {
    const lo = BigInt(u32());
    return lo | (BigInt(u32()) << 32n);
  };
  if (u32() !== THREADS_MAGIC) throw new Error('not a thread description');
  const count = u32();
  const running = u32();
  const status = u32();
  const intMask = u32();
  const threads: DescribedThread[] = [];
  for (let k = 0; k < count; k++) {
    const slot = u32();
    const addr = u32();
    const entry = u32();
    const flags = u32();
    const registers: GuestRegisters = { r: [], hi: 0n, lo: 0n, llbit: 0, f: [], fcsr: 0, fir: 0, fr: 0 };
    for (let i = 0; i < 32; i++) registers.r.push(u64());
    registers.hi = u64();
    registers.lo = u64();
    registers.llbit = u32();
    for (let i = 0; i < 32; i++) registers.f.push(u64());
    registers.fcsr = u32();
    registers.fir = u32();
    registers.fr = u32();
    const blockingSite = u32();
    const frames: ThreadFrame[] = [];
    for (let n = u32(); n > 0; n--) {
      const kind = u32();
      const a = u32();
      const b = u32();
      const c = u32();
      if (kind === FRAME_SITE) frames.push({ kind: 'site', image: a, entry: b, site: c });
      else if (kind === FRAME_RUNTIME) frames.push({ kind: 'runtime', id: a, payload: [b, c] });
      else throw new Error(`unknown frame kind ${kind}`);
    }
    threads.push({ slot, addr, entry, started: (flags & 1) !== 0, parked: (flags & 2) !== 0, registers, blockingSite, frames });
  }
  if (at !== bytes.length) throw new Error('the thread description has trailing bytes');
  return { running, status, intMask, threads };
}

/** Writes a description in the form `parseThreads` reads. */
export function encodeThreads(d: ThreadsDescription): Uint8Array {
  const words: number[] = [];
  const u32 = (v: number) => words.push(v >>> 0);
  const u64 = (v: bigint) => {
    u32(Number(v & 0xffffffffn));
    u32(Number((v >> 32n) & 0xffffffffn));
  };
  u32(THREADS_MAGIC);
  u32(d.threads.length);
  u32(d.running);
  u32(d.status);
  u32(d.intMask);
  for (const t of d.threads) {
    u32(t.slot);
    u32(t.addr);
    u32(t.entry);
    u32((t.started ? 1 : 0) | (t.parked ? 2 : 0));
    t.registers.r.forEach(u64);
    u64(t.registers.hi);
    u64(t.registers.lo);
    u32(t.registers.llbit);
    t.registers.f.forEach(u64);
    u32(t.registers.fcsr);
    u32(t.registers.fir);
    u32(t.registers.fr);
    u32(t.blockingSite);
    u32(t.frames.length);
    for (const f of t.frames) {
      if (f.kind === 'site') [FRAME_SITE, f.image, f.entry, f.site].forEach(u32);
      else [FRAME_RUNTIME, f.id, f.payload[0], f.payload[1]].forEach(u32);
    }
  }
  const out = new Uint8Array(words.length * 4);
  const view = new DataView(out.buffer);
  words.forEach((w, i) => view.setUint32(i * 4, w, true));
  return out;
}
