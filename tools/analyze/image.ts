// Turns one wrapped image into its inventory: functions, jump tables, indirect calls, relocations, data ranges.

import { R_MIPS_26, R_MIPS_32, R_MIPS_HI16 } from '../elf-wrap/elf.ts';
import type { RomContext } from './context.ts';
import type { OverlayLayout } from './layout.ts';
import { freshRegs, step } from './constprop.ts';
import { Code, descend, discover, type FoundFunction, type RootSource } from './discover.ts';
import type { GhidraFacts } from './ghidra.ts';
import { GPR } from './mips.ts';
import { resolveRelocs, type ResolvedReloc } from './relocs.ts';
import type {
  DataKind, InvDataRange, InvFunction, InvImage, InvIndirectCall, InvJumpTable, InvReloc, SectionCoverage,
} from './types.ts';

export interface ImageSpec {
  name: string;
  kind: 'boot' | 'code' | 'segment' | 'overlay';
  fileIndex: number | null;
  base: number;
  /** Everything that is loaded from the file: text, data and rodata for overlays. */
  bytes: Uint8Array;
  entries: { addr: number; why: string }[];
  /** Overlays know where their text ends; boot and main code find out. */
  textEnd: number | null;
  /** Section split of the loaded bytes for overlays. */
  fixedSections: { name: string; start: number; end: number; kind: 'text' | 'data' | 'rodata' }[] | null;
  bss: { start: number; end: number } | null;
  relocs: ResolvedReloc[];
  /** Words of the main code file's descriptor for this overlay that point into it. */
  externalRefs: number[];
}

export function buildSpecs(ctx: RomContext): ImageSpec[] {
  const { boot, code, overlays, segments } = ctx.layout;
  const specs: ImageSpec[] = [];
  specs.push({
    name: 'boot', kind: 'boot', fileIndex: null, base: boot.ramStart,
    bytes: ctx.rom.subarray(boot.romOffset, boot.romOffset + boot.ramEnd - boot.ramStart),
    entries: [
      { addr: boot.entry, why: 'entry address in the ROM header' },
      { addr: boot.mainAddr, why: `jump target of the entry stub at ${hex(boot.entry)}` },
    ],
    textEnd: null, fixedSections: null, bss: { start: boot.bss.start, end: boot.bss.start + boot.bss.size }, relocs: [],
    externalRefs: [],
  });
  const codeBytes = ctx.fileBytes(code.fileIndex);
  specs.push({
    name: 'code', kind: 'code', fileIndex: code.fileIndex, base: code.ramStart, bytes: codeBytes,
    entries: [{ addr: code.entry, why: `called by the boot code at ${hex(code.loadCallAddr)} after loading the file` }],
    textEnd: null, fixedSections: null, bss: { start: code.bss.start, end: code.bss.start + code.bss.size }, relocs: [],
    externalRefs: [],
  });
  for (const g of segments) {
    specs.push({
      name: `seg_${g.ramStart.toString(16)}`, kind: 'segment', fileIndex: g.fileIndex, base: g.ramStart, bytes: ctx.fileBytes(g.fileIndex),
      entries: [{ addr: g.entry, why: `called by the main code after it loaded the file at ${hex(g.ramStart)} (call at ${hex(g.loadCallAddr)})` }],
      textEnd: null, fixedSections: null, bss: g.bss.size ? { start: g.bss.start, end: g.bss.start + g.bss.size } : null, relocs: [],
      externalRefs: [],
    });
  }
  for (const o of overlays) {
    const file = ctx.fileBytes(o.fileIndex);
    const text = o.vramStart;
    const data = text + o.textSize;
    const ro = data + o.dataSize;
    const end = ro + o.rodataSize;
    const bssStart = Math.ceil(end / 16) * 16;
    specs.push({
      name: `ovl_${String(o.fileIndex).padStart(4, '0')}`, kind: 'overlay', fileIndex: o.fileIndex, base: o.vramStart,
      bytes: file.subarray(0, o.headerOffset), entries: [], textEnd: data,
      fixedSections: [
        { name: '.text', start: text, end: data, kind: 'text' },
        { name: '.data', start: data, end: ro, kind: 'data' },
        { name: '.rodata', start: ro, end: end, kind: 'rodata' },
      ],
      bss: o.bssSize ? { start: bssStart, end: bssStart + o.bssSize } : null,
      relocs: resolveRelocs(file, o),
      externalRefs: descriptorRefs(codeBytes, o),
    });
  }
  return specs;
}

function descriptorRefs(codeBytes: Uint8Array, o: OverlayLayout): number[] {
  const dv = new DataView(codeBytes.buffer, codeBytes.byteOffset, codeBytes.byteLength);
  const out: number[] = [];
  const size = o.recordStride || 0x20;
  for (let k = o.recordOffset + 16; k < o.recordOffset + size && k + 4 <= codeBytes.length; k += 4) {
    const w = dv.getUint32(k);
    if (w >= o.vramStart && w < o.vramEnd) out.push(w);
  }
  return out;
}

const hex = (n: number) => '0x' + (n >>> 0).toString(16);
const alignUp = (n: number, a: number) => Math.ceil(n / a) * a;
const sx16 = (n: number) => (n << 16) >> 16;

type Anchor = 'referenced' | 'pointer-target' | 'section-start';

function isPrologueAt(code: Code, a: number): boolean {
  if (!code.contains(a)) return false;
  const i = code.at(a);
  return i.op === 'addiu' && i.rs === 29 && i.rt === 29 && (i.imm & 0x8000) !== 0 && i.imm % 8 === 0;
}

/** Walks each function once with constant propagation and reports every constant address it forms or dereferences. */
function constantAddresses(code: Code, fns: Iterable<FoundFunction>, report: (addr: number, site: number, formed: boolean) => void): void {
  const MEM = /^(l[bhwd]u?|lwl|lwr|ldl|ldr|lwu|s[bhwd]|swl|swr|sdl|sdr|lwc1|swc1|ldc1|sdc1|ll|sc)$/;
  for (const f of fns) {
    let regs = freshRegs();
    // Registers that hold a known base plus an unknown index (an array access).
    let partial = new Map<number, number>();
    let clearAfterSlot = false;
    for (const a of [...f.visited].sort((x, y) => x - y)) {
      const i = code.at(a);
      const base = regs[i.rs] ?? partial.get(i.rs);
      if (MEM.test(i.op) && base !== undefined) report((base + sx16(i.imm)) >>> 0, a, false);
      if (i.op === 'addu') {
        const [x, y] = [regs[i.rs], regs[i.rt]];
        if (x !== undefined && y === undefined && x >= 0x80000000) partial.set(i.rd, x);
        else if (y !== undefined && x === undefined && y >= 0x80000000) partial.set(i.rd, y);
        else partial.delete(i.rd);
      } else if (i.rt > 0 && i.rt !== i.rs && !MEM.test(i.op) && i.kind === 'plain') partial.delete(i.rt);
      step(regs, i);
      if (i.op === 'addiu' || i.op === 'ori' || i.op === 'addu') {
        const v = regs[i.op === 'addu' ? i.rd : i.rt];
        if (v !== undefined && v >= 0x80000000) report(v, a, true);
      }
      if (clearAfterSlot) {
        regs = freshRegs();
        partial = new Map();
        clearAfterSlot = false;
      }
      // Calls and jumps end the straight-line knowledge once their delay slot has run; plain branches keep it.
      if (i.kind === 'call' || i.kind === 'jalr' || i.kind === 'jump' || i.kind === 'jr' || i.kind === 'return') clearAfterSlot = true;
    }
  }
}

function printableRuns(bytes: Uint8Array, from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  let s = -1;
  for (let k = from; k <= to; k++) {
    const b = k < to ? bytes[k]! : -1;
    const ok = (b >= 0x20 && b < 0x7f) || b === 0x0a || b === 0x09;
    if (ok) {
      if (s < 0) s = k;
      continue;
    }
    if (s >= 0 && b === 0 && k - s >= 5) {
      let letters = 0;
      for (let q = s; q < k; q++) if (/[A-Za-z ]/.test(String.fromCharCode(bytes[q]!))) letters++;
      // Binary tables are full of bytes that happen to be printable; text is mostly letters.
      if (letters * 100 >= (k - s) * 85) out.push([s, k + 1]);
    }
    s = -1;
  }
  return out;
}

interface Region {
  start: number;
  end: number;
}

/**
 * Splits [start, end) into typed pieces. Jump tables, strings and zero runs are recognised by content; anything
 * else is identified when it starts at an address some code or data pointer refers to, and runs up to the next
 * such address.
 */
function classifyRegion(
  bytes: Uint8Array, base: number, r: Region, tables: [number, number][], anchors: Map<number, Anchor>,
): InvDataRange[] {
  const n = r.end - r.start;
  const mark = new Uint8Array(n);
  const KINDS: DataKind[] = ['unreferenced', 'jump-table', 'string'];
  for (const [s, e] of tables) {
    for (let a = Math.max(s, r.start); a < Math.min(e, r.end); a++) mark[a - r.start] = 1;
  }
  for (const [s, e] of printableRuns(bytes, r.start - base, r.end - base)) {
    // Include the zero padding that rounds the string up to a word.
    let end = e;
    while (end % 4 && end - (r.start - base) < n && bytes[end] === 0) end++;
    for (let a = s; a < end; a++) if (mark[a - (r.start - base)] === 0) mark[a - (r.start - base)] = 2;
  }
  const out: InvDataRange[] = [];
  const push = (s: number, e: number, kind: DataKind) => {
    const identified = kind !== 'unreferenced';
    const last = out[out.length - 1];
    if (last && last.kind === kind && last.end === s) last.end = e;
    else out.push({ start: s, end: e, kind, identified });
  };
  let k = 0;
  while (k < n) {
    const m = mark[k]!;
    let e = k;
    while (e < n && mark[e] === m) e++;
    if (m !== 0) {
      push(r.start + k, r.start + e, KINDS[m]!);
    } else {
      // Unclassified stretch: cut at every anchor.
      const cuts = [...anchors.keys()].filter((a) => a > r.start + k && a < r.start + e).sort((x, y) => x - y);
      const points = [r.start + k, ...cuts, r.start + e];
      for (let p = 0; p + 1 < points.length; p++) {
        const s = points[p]!;
        const t = points[p + 1]!;
        const anchor = anchors.get(s);
        if (anchor) push(s, t, anchor);
        else {
          // The tail of the object that precedes it, unless a table or string sits in between.
          const prev = out[out.length - 1];
          // A string embedded in an object does not end it: the object continues past the string.
          const owner = prev?.kind === 'string' && out.length > 1 && out[out.length - 2]!.end === prev.start ? out[out.length - 2] : prev;
          const continues = prev !== undefined && prev.end === s && owner !== undefined && (owner.kind === 'referenced' || owner.kind === 'pointer-target' || owner.kind === 'section-start');
          let allZero = true;
          for (let a = s; a < t && allZero; a++) if (bytes[a - base] !== 0) allZero = false;
          if (continues) push(s, t, owner!.kind);
          else if (allZero) push(s, t, t - s < 16 ? 'padding' : 'zero-fill');
          else push(s, t, 'unreferenced');
        }
      }
    }
    k = e;
  }
  return out;
}

const isZeroWord = (code: Code, a: number) => code.word(a) === 0;

export interface AnalyseOptions {
  ghidra?: GhidraFacts | null;
}

/**
 * A function whose code runs on both sides of another function's entry (a subroutine placed inside a larger
 * routine) is cut so that no two ranges overlap: the part before the inner function keeps the entry, the parts
 * after it become fragments that the entry's code reaches by branching.
 */
function splitNested(fns: FoundFunction[], evidence: Map<number, string[]>): FoundFunction[] {
  const out: FoundFunction[] = [];
  const pending = [...fns];
  while (pending.length) {
    const f = pending.pop()!;
    const inner = fns.filter((g) => g !== f && g.start > f.start && g.start < f.end).sort((a, b) => a.start - b.start)[0];
    if (!inner) {
      out.push(f);
      continue;
    }
    const innerEnd = inner.end;
    const inRange = (a: number) => a < inner.start;
    const part = (keep: (a: number) => boolean): FoundFunction => {
      const visited = new Set([...f.visited].filter(keep));
      const addrs = [...visited].sort((a, b) => a - b);
      return {
        ...f, start: addrs[0]!, end: addrs[addrs.length - 1]! + 4, visited,
        jumpTables: f.jumpTables.filter((j) => keep(j.site)),
        indirect: f.indirect.filter((s) => keep(s.addr)),
        calls: new Map([...f.calls].filter(([, site]) => keep(site))),
      };
    };
    const head = part(inRange);
    head.sources = f.sources;
    const tail = part((a) => a >= innerEnd);
    if (tail.visited.size) {
      tail.sources = new Set(['fragment']);
      tail.tailCalls = new Set();
      tail.exits = 1;
      evidence.set(tail.start, [...(evidence.get(tail.start) ?? []), `continuation of the function at ${hex(f.start)} after the function at ${hex(inner.start)}`]);
      pending.push(tail);
    }
    pending.push(head);
  }
  return out.sort((a, b) => a.start - b.start);
}

export function seedAddresses(spec: ImageSpec): Map<number, Set<RootSource>> {
  const roots = new Map<number, Set<RootSource>>();
  for (const e of spec.entries) roots.set(e.addr, new Set(['entry']));
  return roots;
}

/** Roots that need no code analysis: relocations of an overlay say exactly what is a call target or a pointer. */
function relocationRoots(spec: ImageSpec, textStart: number, textEnd: number, evidence: Map<number, string[]>): Map<number, Set<RootSource>> {
  const roots = new Map<number, Set<RootSource>>();
  const add = (t: number, s: RootSource, why: string) => {
    if (t < textStart || t >= textEnd || t % 4) return;
    let set = roots.get(t);
    if (!set) roots.set(t, (set = new Set()));
    set.add(s);
    const ev = evidence.get(t) ?? [];
    if (ev.length < 3) ev.push(why);
    evidence.set(t, ev);
  };
  for (const r of spec.relocs) {
    if (r.target === undefined) continue;
    if (r.type === R_MIPS_26) add(r.target, 'jal', `target of the relocated jump at ${hex(r.addr)}`);
    else if (r.type === R_MIPS_32 && r.section === 2) add(r.target, 'reloc-pointer', `relocated data word at ${hex(r.addr)} points to it`);
    else if (r.type === R_MIPS_HI16) add(r.target, 'address-taken', `relocated hi/lo pair at ${hex(r.addr)} forms its address`);
  }
  return roots;
}

export function analyseImage(spec: ImageSpec, opts: AnalyseOptions = {}): InvImage {
  const { base, bytes } = spec;
  const imageEnd = base + bytes.length;
  const textLimit = spec.textEnd ?? imageEnd;
  const code = new Code({ base, bytes, limit: textLimit });
  const evidence = new Map<number, string[]>();
  const roots = seedAddresses(spec);
  for (const e of spec.entries) evidence.set(e.addr, [e.why]);
  for (const [a, ss] of relocationRoots(spec, base, textLimit, evidence)) {
    const set = roots.get(a) ?? new Set<RootSource>();
    for (const s of ss) set.add(s);
    roots.set(a, set);
  }

  // Function pointers in data and addresses built by code, for images without relocation information.
  const pointerRoots = spec.kind === 'overlay' ? undefined : (fns: Map<number, FoundFunction>) => {
    const out = new Map<number, Set<RootSource>>();
    const add = (t: number, s: RootSource, why: string) => {
      if (!code.contains(t) || t % 4 || fns.has(t) || !isPrologueAt(code, t)) return;
      if (!out.has(t)) out.set(t, new Set());
      out.get(t)!.add(s);
      const ev = evidence.get(t) ?? [];
      if (ev.length < 3) ev.push(why);
      evidence.set(t, ev);
    };
    const covered = new Set<number>();
    for (const f of fns.values()) for (const a of f.visited) covered.add(a);
    for (let a = base; a + 4 <= imageEnd; a += 4) {
      if (covered.has(a)) continue;
      add(code.word(a), 'pointer', `word at ${hex(a)} outside any function holds its address and it opens with a stack-frame setup`);
    }
    constantAddresses(code, fns.values(), (addr, site, formed) => {
      if (formed) add(addr, 'address-taken', `address formed by the instruction at ${hex(site)}`);
    });
    return out;
  };

  const run = (extra?: Map<number, Set<RootSource>>) => {
    const r = new Map(roots);
    if (extra) for (const [a, ss] of extra) r.set(a, new Set([...(r.get(a) ?? []), ...ss]));
    return discover(code, { roots: r, pointerRoots, gapStart: base, gapEnd: spec.textEnd ?? undefined });
  };
  let result = run();

  // Ghidra's functions: those in territory we left uncovered become roots; those inside our functions are conflicts.
  let ghidraStats: InvImage['ghidra'] = null;
  if (opts.ghidra) {
    const theirs = opts.ghidra.functions.map((f) => f.start).filter((a) => a >= base && a < textLimit);
    const extents = [...result.functions.values()].sort((a, b) => a.start - b.start);
    const inside = (a: number) => extents.some((f) => a > f.start && a < f.end);
    const extra = new Map<number, Set<RootSource>>();
    let agree = 0;
    let only = 0;
    for (const g of theirs) {
      if (result.functions.has(g)) {
        agree++;
        continue;
      }
      only++;
      if (inside(g) || g % 4) continue;
      const f = descend(code, g, new Set(result.functions.keys()), new Set());
      if (f.invalid.length || f.exits === 0) continue;
      extra.set(g, new Set(['ghidra']));
      evidence.set(g, [...(evidence.get(g) ?? []), 'Ghidra analysis created a function here']);
    }
    if (extra.size) result = run(extra);
    ghidraStats = {
      functions: theirs.length, agree, onlyGhidra: only,
      onlyOurs: [...result.functions.keys()].filter((a) => !theirs.includes(a)).length,
    };
  }

  const fnList = splitNested([...result.functions.values()].sort((a, b) => a.start - b.start), evidence);
  const callerOf = new Map<number, number>();
  for (const f of fnList) for (const [t, site] of f.calls) if (!callerOf.has(t)) callerOf.set(t, site);

  const functions: InvFunction[] = fnList.map((f) => {
    const sources = [...f.sources];
    const ev = [...(evidence.get(f.start) ?? [])];
    const site = callerOf.get(f.start);
    if (site !== undefined && !sources.includes('jal')) sources.push('jal');
    if (site !== undefined) ev.push(`called by the jal at ${hex(site)}`);
    const strong = sources.filter((s) => s !== 'gap');
    let confidence: InvFunction['confidence'];
    if (strong.length > 0) confidence = 'high';
    else if (isPrologueAt(code, f.start)) confidence = 'medium';
    else confidence = 'low';
    if (sources.includes('gap')) {
      ev.push(`first instruction after ${hex(f.start - 4)} not covered by any other function${isPrologueAt(code, f.start) ? '; starts with a stack-frame setup' : ''}`);
    }
    if (f.tailCalls.size) ev.push(`jumps out to ${[...f.tailCalls].map(hex).join(', ')}`);
    return {
      start: f.start, end: f.end, name: null, confidence, sources, evidence: ev,
      calls: [...new Set([...f.calls.keys(), ...f.tailCalls])].sort((a, b) => a - b),
    };
  });

  const jumpTables: InvJumpTable[] = fnList.flatMap((f) =>
    f.jumpTables.map((t) => ({ addr: t.addr, entries: t.entries, targets: t.targets, site: t.site, function: f.start, bound: t.bound })),
  );
  const ghidraIndirect = new Map((opts.ghidra?.indirect ?? []).map((x) => [x.addr, x]));
  const indirectCalls: InvIndirectCall[] = fnList.flatMap((f) =>
    f.indirect.filter((s) => s.kind === 'jalr').map((s) => ({
      addr: s.addr, function: f.start, reg: GPR[s.reg]!, targets: ghidraIndirect.get(s.addr)?.targets ?? [],
    })),
  );

  // ---- sections ----
  const textEnd = spec.textEnd ?? alignUp(Math.max(base, result.textEnd), 16);
  const sections: InvImage['sections'] = spec.fixedSections
    ? spec.fixedSections.map((s) => ({ ...s }))
    : [
        { name: '.text', start: base, end: textEnd, kind: 'text' },
        { name: '.data', start: textEnd, end: imageEnd, kind: 'data' },
      ];
  if (spec.bss) sections.push({ name: '.bss', start: spec.bss.start, end: spec.bss.end, kind: 'bss' });

  // ---- data anchors ----
  const dataStart = spec.fixedSections ? spec.fixedSections[1]!.start : textEnd;
  const inData = (a: number) => (a >= dataStart && a < imageEnd) || result.islands.some(([s, e]) => a >= s && a < e);
  const anchors = new Map<number, Anchor>();
  constantAddresses(code, result.functions.values(), (addr) => {
    if (inData(addr)) anchors.set(addr, 'referenced');
  });
  for (const r of spec.relocs) {
    if (r.target !== undefined && r.type !== R_MIPS_26 && inData(r.target)) anchors.set(r.target, 'referenced');
  }
  for (let a = dataStart; a + 4 <= imageEnd; a += 4) {
    const w = code.word(a);
    if (w % 4 === 0 && inData(w) && !anchors.has(w)) anchors.set(w, 'pointer-target');
  }
  for (const w of spec.externalRefs) if (inData(w)) anchors.set(w, 'referenced');
  for (const t of jumpTables) anchors.set(t.addr, 'referenced');
  for (const sec of sections) if ((sec.kind === 'data' || sec.kind === 'rodata') && !anchors.has(sec.start)) anchors.set(sec.start, 'section-start');
  const tableRanges = jumpTables.map((t): [number, number] => [t.addr, t.addr + t.entries * 4]);

  // ---- text coverage and data ranges ----
  const data: InvDataRange[] = [];
  const coverage: SectionCoverage[] = [];
  const textSections = sections.filter((s) => s.kind === 'text');
  for (const sec of textSections) {
    const covered = new Uint8Array((sec.end - sec.start) / 4);
    let fnBytes = 0;
    for (const f of fnList) {
      for (let a = Math.max(f.start, sec.start); a < Math.min(f.end, sec.end); a += 4) {
        if (!covered[(a - sec.start) / 4]) fnBytes += 4;
        covered[(a - sec.start) / 4] = 1;
      }
    }
    let padBytes = 0;
    let dataBytes = 0;
    const islandRanges = result.islands.filter(([s]) => s >= sec.start && s < sec.end);
    for (const [s, e] of islandRanges) {
      const end = Math.min(e, sec.end);
      const ranges = classifyRegion(bytes, base, { start: s, end }, tableRanges, anchors);
      data.push(...ranges);
      for (const r of ranges) {
        if (r.identified) dataBytes += r.end - r.start;
        for (let a = r.start; a < r.end; a += 4) covered[(a - sec.start) / 4] = 1;
      }
      // Bytes that stayed unidentified are not credited.
      for (const r of ranges) if (!r.identified) for (let a = r.start; a < r.end; a += 4) covered[(a - sec.start) / 4] = 0;
    }
    for (let a = sec.start; a < sec.end; a += 4) {
      if (!covered[(a - sec.start) / 4] && isZeroWord(code, a)) {
        padBytes += 4;
        covered[(a - sec.start) / 4] = 1;
      }
    }
    const total = sec.end - sec.start;
    const unassigned = total - fnBytes - padBytes - dataBytes;
    coverage.push({
      name: sec.name, start: sec.start, end: sec.end, bytes: total, functionBytes: fnBytes, paddingBytes: padBytes,
      dataBytes, unassignedBytes: unassigned, percent: total ? (100 * (total - unassigned)) / total : 100,
    });
  }
  for (const sec of sections.filter((s) => s.kind === 'data' || s.kind === 'rodata')) {
    const ranges = classifyRegion(bytes, base, { start: sec.start, end: sec.end }, tableRanges, anchors);
    data.push(...ranges);
    const total = sec.end - sec.start;
    let ident = 0;
    let pad = 0;
    for (const r of ranges) {
      if (r.identified) ident += r.end - r.start;
      if (r.kind === 'padding' || r.kind === 'zero-fill') pad += r.end - r.start;
    }
    coverage.push({
      name: sec.name, start: sec.start, end: sec.end, bytes: total, functionBytes: 0, paddingBytes: pad,
      dataBytes: ident - pad, unassignedBytes: total - ident, percent: total ? (100 * ident) / total : 100,
    });
  }

  const relocations: InvReloc[] = spec.relocs.map((r) => ({
    addr: r.addr, type: r.type, section: (['text', 'data', 'rodata'] as const)[r.section - 1]!, target: r.target ?? null,
  }));
  return {
    name: spec.name, kind: spec.kind, fileIndex: spec.fileIndex, entry: spec.entries[0]?.addr ?? null, sections, functions,
    jumpTables, indirectCalls, relocations, data: data.sort((a, b) => a.start - b.start), coverage, ghidra: ghidraStats,
  };
}
