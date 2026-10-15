// Our own function discovery: recursive descent over MIPS with jump-table recovery and gap filling.
// Ghidra's findings enter as extra roots; everything reported here is derived from the image bytes.

import { decode, type Insn } from './mips.ts';

export type RootSource = 'entry' | 'seed' | 'jal' | 'ghidra' | 'pointer' | 'address-taken' | 'tail-jump' | 'gap' | 'reloc-pointer' | 'fragment';

export interface ImageCode {
  base: number;
  bytes: Uint8Array;
  /** Descent never goes past this address (exclusive). */
  limit: number;
}

export interface JumpTable {
  /** Address of the first table entry. */
  addr: number;
  entries: number;
  targets: number[];
  /** Address of the `jr` that uses it. */
  site: number;
  /** How the entry count was bounded. */
  bound: 'sltiu' | 'scan';
}

export interface IndirectSite {
  addr: number;
  kind: 'jalr' | 'jr';
  reg: number;
  /** Targets known from a jump table. */
  targets?: number[];
}

export interface FoundFunction {
  start: number;
  /** One past the last byte of any instruction of the function. */
  end: number;
  sources: Set<RootSource>;
  /** Instruction addresses reached from the entry. */
  visited: Set<number>;
  jumpTables: JumpTable[];
  indirect: IndirectSite[];
  /** Direct callees, with the address of the first call instruction for each. */
  calls: Map<number, number>;
  /** Set when descent met a word that is not a valid instruction. */
  invalid: number[];
  /** Jump targets outside the function that were treated as tail calls. */
  tailCalls: Set<number>;
  /** Number of returns and jumps out of the function reached by the descent. */
  exits: number;
}

export class Code {
  readonly dv: DataView;
  private cache = new Map<number, Insn>();
  constructor(readonly img: ImageCode) {
    this.dv = new DataView(img.bytes.buffer, img.bytes.byteOffset, img.bytes.byteLength);
  }
  contains(a: number): boolean {
    return a >= this.img.base && a < this.img.base + this.img.bytes.length;
  }
  word(a: number): number {
    return this.dv.getUint32(a - this.img.base);
  }
  at(a: number): Insn {
    let i = this.cache.get(a);
    if (!i) {
      i = decode(this.word(a), a);
      this.cache.set(a, i);
    }
    return i;
  }
}

interface Abs {
  c: number;
  idx: boolean;
}

/** Looks backwards from a `jr` for the load of a jump-table entry and the bound check on the index. */
export function recoverJumpTable(code: Code, jrAddr: number, fnStart: number): JumpTable | undefined {
  const jr = code.at(jrAddr);
  const from = Math.max(fnStart, jrAddr - 4 * 48);
  const regs = new Map<number, Abs | undefined>();
  let table: number | undefined;
  let bound: number | undefined;
  for (let a = from; a < jrAddr; a += 4) {
    const i = code.at(a);
    const s = regs.get(i.rs);
    const t = regs.get(i.rt);
    const simm = (i.imm << 16) >> 16;
    switch (i.op) {
      case 'lui': regs.set(i.rt, { c: (i.imm << 16) >>> 0, idx: false }); break;
      case 'ori': regs.set(i.rt, s ? { c: (s.c | i.imm) >>> 0, idx: s.idx } : undefined); break;
      case 'addiu': case 'addi': regs.set(i.rt, s ? { c: (s.c + simm) >>> 0, idx: s.idx } : undefined); break;
      case 'addu': case 'add': {
        if (s && !t) regs.set(i.rd, { c: s.c, idx: true });
        else if (t && !s) regs.set(i.rd, { c: t.c, idx: true });
        else if (s && t) regs.set(i.rd, { c: (s.c + t.c) >>> 0, idx: s.idx || t.idx });
        else regs.set(i.rd, undefined);
        break;
      }
      case 'lw': {
        if (s && s.idx && i.rt === jr.rs) {
          table = (s.c + simm) >>> 0;
          regs.set(i.rt, undefined);
        } else regs.set(i.rt, undefined);
        break;
      }
      case 'sltiu': if (i.imm > 1) bound = i.imm; regs.set(i.rt, undefined); break;
      default: {
        if (i.kind === 'plain' || i.kind === 'call') {
          const w = i.word >>> 26 === 0 ? i.rd : i.rt;
          if (!['sw', 'sb', 'sh', 'swc1', 'sd', 'nop'].includes(i.op) && w > 0) regs.set(w, undefined);
        }
      }
    }
  }
  if (table === undefined || !code.contains(table) || table % 4) return undefined;
  const targets: number[] = [];
  const max = bound ?? 4096;
  for (let k = 0; k < max; k++) {
    const p = table + k * 4;
    if (!code.contains(p)) break;
    const w = code.word(p);
    if (w % 4 || w < fnStart || w >= code.img.limit || !code.contains(w) || code.at(w).op === '.word') break;
    targets.push(w);
  }
  if (targets.length < 2 || (bound !== undefined && targets.length < bound)) {
    if (targets.length < 2) return undefined;
  }
  return { addr: table, entries: targets.length, targets, site: jrAddr, bound: bound !== undefined ? 'sltiu' : 'scan' };
}

/**
 * Follows control flow from `start`. `barriers` are addresses of other functions: reaching one ends the path
 * (a fall-through into the next function, or a tail jump).
 */
export function descend(code: Code, start: number, barriers: Set<number>, sources: Set<RootSource>): FoundFunction {
  const f: FoundFunction = {
    start, end: start, sources, visited: new Set(), jumpTables: [], indirect: [], calls: new Map(), invalid: [], tailCalls: new Set(), exits: 0,
  };
  const work: number[] = [start];
  const mark = (a: number) => {
    f.visited.add(a);
    if (a + 4 > f.end) f.end = a + 4;
  };
  while (work.length) {
    let pc = work.pop()!;
    for (;;) {
      if (f.visited.has(pc)) break;
      if (!code.contains(pc) || pc >= code.img.limit || pc % 4) break;
      if (pc !== start && barriers.has(pc)) {
        f.exits++;
        break;
      }
      const i = code.at(pc);
      if (i.op === '.word') {
        f.invalid.push(pc);
        break;
      }
      mark(pc);
      if (i.op === 'eret') {
        f.exits++;
        break;
      }
      if (i.kind === 'plain') {
        pc += 4;
        continue;
      }
      const slot = pc + 4;
      if (code.contains(slot) && !f.visited.has(slot)) {
        const d = code.at(slot);
        if (d.op === '.word') f.invalid.push(slot);
        else mark(slot);
      }
      const next = pc + 8;
      if (i.kind === 'branch') {
        if (i.target !== undefined && !barriers.has(i.target)) work.push(i.target);
        // An unconditional branch (beq r,r / bgez zero / b) does not fall through.
        const always = (i.op === 'beq' && i.rs === i.rt) || (i.op === 'bgez' && i.rs === 0);
        if (always) {
          f.exits++;
          break;
        }
        pc = next;
        continue;
      }
      if (i.kind === 'call') {
        if (i.target !== undefined && !f.calls.has(i.target)) f.calls.set(i.target, pc);
        pc = next;
        continue;
      }
      if (i.kind === 'jump') {
        const t = i.target!;
        if ((barriers.has(t) && t !== start) || t < start) {
          f.tailCalls.add(t);
          f.exits++;
        } else work.push(t);
        break;
      }
      if (i.kind === 'jalr') {
        f.indirect.push({ addr: pc, kind: 'jalr', reg: i.rs });
        pc = next;
        continue;
      }
      if (i.kind === 'jr') {
        const jt = recoverJumpTable(code, pc, start);
        if (jt) {
          f.jumpTables.push(jt);
          f.indirect.push({ addr: pc, kind: 'jr', reg: i.rs, targets: jt.targets });
          for (const t of jt.targets) if (!barriers.has(t) || t === start) work.push(t);
        } else f.indirect.push({ addr: pc, kind: 'jr', reg: i.rs });
        f.exits++;
        break;
      }
      f.exits++;
      break; // return
    }
  }
  return f;
}

export interface DiscoverResult {
  functions: Map<number, FoundFunction>;
  /** Stretches inside the text that look like data (tables between functions). */
  islands: [number, number][];
  /** End of the code the descent covers; data follows. */
  textEnd: number;
}

export interface DiscoverOptions {
  roots: Map<number, Set<RootSource>>;
  /** Extra data-pointer candidate scanner, run once the first functions are known. */
  pointerRoots?: (functions: Map<number, FoundFunction>) => Map<number, Set<RootSource>>;
  /** Where gap-filling may start/stop; gaps outside are left alone. */
  gapStart: number;
  /** When the end of the text is known, gap filling covers all of it instead of stopping at the last known function. */
  gapEnd?: number;
}

const isNop = (w: number) => w === 0;

export function discover(code: Code, opts: DiscoverOptions): DiscoverResult {
  const roots = new Map<number, Set<RootSource>>();
  const addRoot = (a: number, s: RootSource) => {
    if (!code.contains(a) || a % 4 || a >= code.img.limit) return false;
    let set = roots.get(a);
    if (!set) roots.set(a, (set = new Set()));
    const had = set.has(s);
    set.add(s);
    return !had;
  };
  for (const [a, ss] of opts.roots) for (const s of ss) addRoot(a, s);

  let functions = new Map<number, FoundFunction>();
  const run = () => {
    for (let round = 0; round < 40; round++) {
      const barriers = new Set(roots.keys());
      functions = new Map();
      let grew = false;
      for (const [a, ss] of [...roots].sort((x, y) => x[0] - y[0])) {
        const f = descend(code, a, barriers, ss);
        functions.set(a, f);
        for (const c of f.calls.keys()) if (addRoot(c, 'jal')) grew = true;
        for (const t of f.tailCalls) if (addRoot(t, 'tail-jump')) grew = true;
      }
      if (!grew) return;
    }
  };
  run();

  if (opts.pointerRoots) {
    const extra = opts.pointerRoots(functions);
    let grew = false;
    for (const [a, ss] of extra) for (const s of ss) if (addRoot(a, s)) grew = true;
    if (grew) run();
  }

  // The text ends where the last root-reachable code ends; gap filling stays below that.
  let textEnd = opts.gapEnd ?? opts.gapStart;
  for (const f of functions.values()) textEnd = Math.max(textEnd, f.end);
  const islands = new Map<number, number>();
  const isPrologue = (a: number) => {
    const i = code.at(a);
    return i.op === 'addiu' && i.rs === 29 && i.rt === 29 && (i.imm & 0x8000) !== 0 && i.imm % 8 === 0;
  };
  const plausible = (f: FoundFunction) => {
    if (f.invalid.length || f.exits === 0) return false;
    const i = code.at(f.start);
    // A first instruction that writes $zero is data decoded as code.
    return !(i.word >>> 26 === 0 && i.rd === 0 && i.kind === 'plain' && i.word !== 0);
  };
  for (let pass = 0; pass < 50; pass++) {
    const sorted = [...functions.values()].sort((a, b) => a.start - b.start);
    const covered = new Set<number>();
    for (const f of sorted) for (let a = f.start; a < f.end; a += 4) covered.add(a);
    let added = false;
    let a = opts.gapStart;
    while (a < textEnd) {
      const isl = islands.get(a);
      if (isl !== undefined) {
        a = isl;
        continue;
      }
      if (covered.has(a) || isNop(code.word(a))) {
        a += 4;
        continue;
      }
      const f = code.at(a).op === '.word' ? undefined : descend(code, a, new Set(roots.keys()), new Set());
      if (f && plausible(f)) {
        // First real instruction of an uncovered stretch: a function nothing else points at.
        if (addRoot(a, 'gap')) added = true;
        for (let x = f.start; x < f.end; x += 4) covered.add(x);
        for (const c of f.calls.keys()) if (addRoot(c, 'jal')) added = true;
        a = f.end;
        continue;
      }
      let e = a + 4;
      while (e < textEnd && !covered.has(e) && !isPrologue(e)) e += 4;
      islands.set(a, e);
      a = e;
    }
    if (!added) break;
    run();
    textEnd = Math.max(textEnd, ...[...functions.values()].map((f) => f.end));
  }
  return { functions, textEnd, islands: [...islands].sort((x, y) => x[0] - y[0]) };
}
