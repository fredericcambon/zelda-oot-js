// The static sweep: what the game can ask of the runtime, read from the binary. RSP tasks, the opcode tables of the
// graphics and audio microcode, the OS routines, the memory-mapped register accesses and the recompiler's gaps.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RomContext } from '../analyze/context.ts';
import { freshRegs, step } from '../analyze/constprop.ts';
import { buildSpecs, type ImageSpec } from '../analyze/image.ts';
import { disassemble, type Insn } from '../analyze/mips.ts';
import type { Inventory, InvFunction, InvImage } from '../analyze/types.ts';
import { disassembleRspRange } from '../audio/rspdis.ts';
import type { CDisplayListInterpreter } from '../gfx/c-dl.ts';
import { Op } from '../gfx/opcodes.ts';
import { Synth } from '../audio/synth.ts';
import { ENTRANCE_COUNT, ENTRANCE_TABLE, SCENE_TABLE } from '../headless/state.ts';
import { isMmio, registerName } from './mmio.ts';

export const BOOT_HALT_UCODE = 0x800066c0;
export const JPEG_UCODE = 0x800e4b10;
const GFX_UCODE_DESCRIPTOR = 0x800fcd80;
/** The microcode data memory offset of the graphics microcode's opcode table (halfwords, indexed by the signed opcode byte). */
const GFX_TABLE_BASE = 0x36e;
/** Instruction memory addresses at which the graphics microcode forwards a command to the RDP. */
const GFX_RDP_FORWARD = new Set([0x1208, 0x120c, 0x1218]);
const AUDIO_TABLE = 0x10;

const hex = (n: number, w = 0) => (n >>> 0).toString(16).padStart(w, '0');
const h = (n: number) => `0x${hex(n)}`;

// ---- Shared scanning ---------------------------------------------------------------------------------------------

interface Located {
  image: string;
  fn: InvFunction;
  insns: Insn[];
}

function* eachFunction(inv: Inventory, specs: Map<string, ImageSpec>): Generator<Located> {
  for (const img of inv.images) {
    const spec = specs.get(img.name)!;
    for (const fn of img.functions) yield { image: img.name, fn, insns: disassemble(spec.bytes, spec.base, fn.start - spec.base, fn.end - spec.base) };
  }
}

/** Register values after each instruction; cleared once a control transfer and its delay slot are done. `across` keeps them over branches. */
function* withRegs(insns: Insn[], across: boolean): Generator<{ insn: Insn; before: ReturnType<typeof freshRegs>; index: number }> {
  let regs = freshRegs();
  for (let i = 0; i < insns.length; i++) {
    const insn = insns[i]!;
    yield { insn, before: regs, index: i };
    step(regs, insn);
    const previous = insns[i - 1];
    if (previous && previous.kind !== 'plain' && (!across || previous.kind !== 'branch')) regs = freshRegs();
  }
}

// ---- RSP tasks ---------------------------------------------------------------------------------------------------

export interface RspTask {
  type: number;
  /** Where the record comes from: a template copied into a scheduler record, or code that fills a record field by field. */
  source: 'template' | 'builder';
  address: number;
  /** Functions that reference the template, or the builder itself. */
  functions: number[];
  /** Microcode text pointer, or null when the builder takes it from a variable. */
  ucode: number | null;
  ucodeSize: number | null;
  ucodeData: number | null;
  /** Words the microcode begins with (instruction memory image), for the identification. */
  ucodeHead: string[];
  note: string;
  runtime: string;
  handled: boolean;
}

export interface TaskSubmitter {
  routine: string;
  address: number;
  callers: number[];
}

/** What runtime/rsp.c does with a task of this type and microcode. */
export function runtimeHandling(type: number, ucode: number | null): { handled: boolean; text: string } {
  if (type === 1) return { handled: true, text: 'graphics task: the display-list interpreter and renderer (rt_set_gfx_hook)' };
  if (type === 2) return { handled: true, text: 'audio task: the command-list mixer (rt_set_audio_hook)' };
  if (type === 4 && ucode === JPEG_UCODE) return { handled: true, text: 'JPEG decode in runtime/jpeg.c' };
  if (type === 4 && ucode === BOOT_HALT_UCODE) return { handled: true, text: 'completes with the SP event, nothing to run' };
  return { handled: false, text: 'trap: "RSP task of unknown type"' };
}

function identifyMicrocode(spec: ImageSpec, ucode: number | null): string[] {
  if (ucode === null || ucode < spec.base || ucode + 16 > spec.base + spec.bytes.length) return [];
  return disassembleRspRange(spec.bytes.subarray(ucode - spec.base, ucode - spec.base + 12), 0).slice(0, 3);
}

function dataWords(spec: ImageSpec): DataView {
  return new DataView(spec.bytes.buffer, spec.bytes.byteOffset, spec.bytes.byteLength);
}

const isPointer = (v: number) => v >= 0x80000000 && v < 0x80800000;

/** Every graphics, audio and JPEG task the code can build, and who hands tasks to the RSP. */
export function rspTasks(inv: Inventory, specs: Map<string, ImageSpec>): { tasks: RspTask[]; submitters: TaskSubmitter[] } {
  const routines = (inv.os as { routines: { id: string; addr: number | null; status: string }[] }).routines;
  const submitters: TaskSubmitter[] = [];
  for (const id of ['osSpTaskLoad', 'osSpTaskStartGo', 'osSpTaskYield', 'osSpTaskYielded']) {
    const r = routines.find((x) => x.id === id && x.status === 'found');
    if (!r?.addr) continue;
    const callers = inv.images.flatMap((img) => img.functions.filter((f) => f.calls.includes(r.addr!)).map((f) => f.start));
    submitters.push({ routine: id, address: r.addr, callers });
  }

  const tasks: RspTask[] = [];
  const code = specs.get('code')!;
  const specFor = (addr: number): ImageSpec => {
    const boot = specs.get('boot')!;
    return addr >= boot.base && addr < boot.base + boot.bytes.length ? boot : code;
  };
  const codeView = dataWords(code);
  const descriptor = { text: codeView.getUint32(GFX_UCODE_DESCRIPTOR - code.base), data: codeView.getUint32(GFX_UCODE_DESCRIPTOR - code.base + 4) };

  // Templates: 64-byte records in the data whose type, microcode pointers and sizes fit the task layout of runtime/rsp.c.
  for (const spec of [specs.get('boot')!, code]) {
    const dv = dataWords(spec);
    for (let o = 0; o + 64 <= spec.bytes.length; o += 4) {
      const w = (i: number) => dv.getUint32(o + 4 * i);
      if (![1, 2, 4].includes(w(0)) || w(1) >= 16 || !(isPointer(w(2)) || w(2) === 0) || w(3) > 0x2000 || !isPointer(w(4)) || w(5) === 0 || w(5) > 0x2000) continue;
      const handling = runtimeHandling(w(0), w(4));
      tasks.push({
        type: w(0), source: 'template', address: spec.base + o, functions: [], ucode: w(4), ucodeSize: w(5), ucodeData: isPointer(w(6)) ? w(6) : null,
        ucodeHead: identifyMicrocode(specFor(w(4)), w(4)),
        note: w(2) !== 0 ? `boot microcode ${h(w(2))} (${h(w(3))} bytes)` : 'the code fills in the boot microcode and the data pointer before submitting',
        runtime: handling.text, handled: handling.handled,
      });
    }
  }

  // Builders: code that stores a type and the microcode size into a record and fills at least four of its other fields.
  // The same pass finds the functions that load a template's address.
  const FIELDS = new Set([4, 8, 12, 16, 20, 24, 28, 48, 52]);
  const templateUsers = new Map<number, Set<number>>(tasks.map((t) => [t.address, new Set<number>()]));
  for (const l of eachFunction(inv, specs)) {
    const stores: { i: number; base: number; off: number; val?: number }[] = [];
    for (const { insn, before, index } of withRegs(l.insns, false)) {
      if (insn.op === 'sw') stores.push({ i: index, base: insn.rs, off: (insn.imm << 16) >> 16, val: before[insn.rt] });
      if (insn.op === 'addiu' || insn.op === 'ori') {
        const regs = before.slice();
        step(regs, insn);
        const users = regs[insn.rt] === undefined ? undefined : templateUsers.get(regs[insn.rt]!);
        users?.add(l.fn.start);
      }
    }
    for (const t of stores) {
      if (t.off !== 0 || t.val === undefined || ![1, 2, 4].includes(t.val)) continue;
      const near = stores.filter((u) => u.base === t.base && Math.abs(u.i - t.i) < 40 && FIELDS.has(u.off));
      const size = near.find((u) => u.off === 0x14);
      if (new Set(near.map((u) => u.off)).size < 4 || size?.val === undefined || size.val < 0x400 || size.val > 0x2000) continue;
      const pointer = near.find((u) => u.off === 0x10)?.val;
      const data = near.find((u) => u.off === 0x18)?.val;
      const fromDescriptor = pointer === undefined && t.val === 1;
      const ucode = fromDescriptor ? descriptor.text : pointer ?? null;
      const handling = runtimeHandling(t.val, ucode);
      tasks.push({
        type: t.val, source: 'builder', address: l.fn.start, functions: [l.fn.start], ucode, ucodeSize: size.val,
        ucodeData: fromDescriptor ? descriptor.data : data ?? null,
        ucodeHead: ucode === null ? [] : identifyMicrocode(specFor(ucode), ucode),
        note: fromDescriptor
          ? `microcode and data pointers come from the descriptor at ${h(GFX_UCODE_DESCRIPTOR)}`
          : pointer === undefined ? 'the microcode pointer comes from a variable' : 'constant microcode pointers',
        runtime: handling.text, handled: handling.handled,
      });
    }
  }
  for (const t of tasks) if (t.source === 'template') t.functions = [...templateUsers.get(t.address)!].sort((a, b) => a - b);
  tasks.sort((a, b) => a.type - b.type || a.address - b.address);
  return { tasks, submitters };
}

// ---- Microcode texts ---------------------------------------------------------------------------------------------

export interface MicrocodeText {
  address: number;
  /** Functions that build the address (physical or KSEG0 form) and data words that hold it. */
  functions: number[];
  dataWords: number[];
  head: string[];
}

/** RSP code that the game's code references: 16-byte aligned addresses of the microcode area whose first instructions decode as RSP code. */
export function microcodeTexts(inv: Inventory, specs: Map<string, ImageSpec>): MicrocodeText[] {
  const code = specs.get('code')!;
  const inArea = (v: number) => (v >= 0xe0000 && v < 0xe8000) || (v >= 0x800e0000 && v < 0x800e8000);
  const found = new Map<number, MicrocodeText>();
  const entry = (v: number): MicrocodeText | undefined => {
    const address = (v & 0x1fffffff) + 0x80000000;
    if ((address & 0xf) !== 0 || address + 256 > code.base + code.bytes.length) return undefined;
    let item = found.get(address);
    if (!item) {
      // The first 64 instructions of microcode move values through the RSP's control registers (c0r) or use vector registers.
      const head = disassembleRspRange(code.bytes.subarray(address - code.base, address - code.base + 256), 0);
      if (head.some((l) => l.includes('.word')) || head.filter((l) => /c0r\d|\b[ls][bslqdprtuhfw]v\b|\bv[a-z]{2,5}\b/.test(l)).length < 3) return undefined;
      item = { address, functions: [], dataWords: [], head: head.slice(0, 3) };
      found.set(address, item);
    }
    return item;
  };
  for (const l of eachFunction(inv, specs)) {
    for (const { insn, before } of withRegs(l.insns, false)) {
      if (insn.op !== 'addiu' && insn.op !== 'ori') continue;
      const regs = before.slice();
      step(regs, insn);
      const v = regs[insn.rt];
      if (v !== undefined && inArea(v)) {
        const item = entry(v);
        if (item && !item.functions.includes(l.fn.start)) item.functions.push(l.fn.start);
      }
    }
  }
  const dv = dataWords(code);
  for (let a = 0; a + 4 <= code.bytes.length; a += 4) {
    const v = dv.getUint32(a);
    if (inArea(v)) entry(v)?.dataWords.push(code.base + a);
  }
  // Words of data that merely point into the area are too often the middle of a text or data block; code that builds the address is the evidence.
  return [...found.values()].filter((m) => m.functions.length > 0).sort((a, b) => a.address - b.address);
}

// ---- Microcode opcode tables -------------------------------------------------------------------------------------

export type OpcodeStatus = 'implemented' | 'unsupported-by-design' | 'missing';

export interface OpcodeRow {
  op: number;
  name: string;
  /** Handler address in the microcode's instruction memory (0x1000 is the first instruction), or null when the table holds no handler. */
  handler: number | null;
  status: OpcodeStatus;
  reason: string;
  /** First instructions of the handler, for opcodes the runtime lacks. */
  head: string[];
}

/** RDP command names by command number, from the RDP command list on n64brew.dev. */
const RDP_NAMES: Record<number, string> = {
  0x24: 'TEXTURE_RECTANGLE', 0x25: 'TEXTURE_RECTANGLE_FLIP', 0x26: 'SYNC_LOAD', 0x27: 'SYNC_PIPE', 0x28: 'SYNC_TILE', 0x29: 'SYNC_FULL',
  0x2a: 'SET_KEY_GB', 0x2b: 'SET_KEY_R', 0x2c: 'SET_CONVERT', 0x2d: 'SET_SCISSOR', 0x2e: 'SET_PRIM_DEPTH', 0x2f: 'SET_OTHER_MODES',
  0x30: 'LOAD_TLUT', 0x32: 'SET_TILE_SIZE', 0x33: 'LOAD_BLOCK', 0x34: 'LOAD_TILE', 0x35: 'SET_TILE', 0x36: 'FILL_RECTANGLE',
  0x37: 'SET_FILL_COLOR', 0x38: 'SET_FOG_COLOR', 0x39: 'SET_BLEND_COLOR', 0x3a: 'SET_PRIM_COLOR', 0x3b: 'SET_ENV_COLOR',
  0x3c: 'SET_COMBINE_MODE', 0x3d: 'SET_TEXTURE_IMAGE', 0x3e: 'SET_MASK_IMAGE', 0x3f: 'SET_COLOR_IMAGE',
};

const OP_NAMES = new Map<number, string>(Object.entries(Op).map(([name, value]) => [value, name]));

function gfxName(op: number): string {
  const ours = OP_NAMES.get(op);
  if (ours) return ours;
  return op >= 0xe4 ? `RDP ${RDP_NAMES[op & 0x3f] ?? `command 0x${hex(op & 0x3f)}`}` : '';
}

/** Whether the display-list interpreter accepts a command with this opcode. */
function interpreterAccepts(interpreter: CDisplayListInterpreter, op: number): boolean {
  const ram = new Uint8Array(64);
  const dv = new DataView(ram.buffer);
  dv.setUint32(0, op * 0x1000000);
  dv.setUint32(16, 0xdf000000);
  dv.setUint32(8, 0xdf000000);
  const result = interpreter.run(ram, 0, { maxCommands: 6 });
  return result.unknown.length === 0;
}

export function graphicsOpcodes(specs: Map<string, ImageSpec>, interpreter: CDisplayListInterpreter): { table: OpcodeRow[]; ucode: number; data: number; signature: string } {
  const code = specs.get('code')!;
  const dv = dataWords(code);
  const text = dv.getUint32(GFX_UCODE_DESCRIPTOR - code.base);
  const data = dv.getUint32(GFX_UCODE_DESCRIPTOR - code.base + 4);
  const dmem = new DataView(code.bytes.buffer, code.bytes.byteOffset + data - code.base, 0x800);
  const listing = disassembleRspRange(code.bytes.subarray(text - code.base, text - code.base + 0x1000), 0);
  const at = (offset: number) => listing.slice(offset / 4, offset / 4 + 4);
  const table: OpcodeRow[] = [];
  const entryOf = (op: number) => dmem.getUint16(GFX_TABLE_BASE + 2 * (op < 128 ? op : op - 256));
  const isHandler = (entry: number) => entry >= 0x1000 && entry < 0x2000 && (entry & 3) === 0;
  // The table is the run of instruction memory addresses around its base: down from opcode 0xff and up from 0x00. The words
  // beyond either end are other data that happens to be read by a stray opcode.
  const inTable = new Set<number>();
  for (let op = 0xff; op >= 0x80 && isHandler(entryOf(op)); op--) inTable.add(op);
  for (let op = 0; op < 0x80 && isHandler(entryOf(op)); op++) inTable.add(op);
  for (let op = 0; op < 256; op++) {
    const entry = entryOf(op);
    const hasHandler = inTable.has(op);
    const accepted = interpreterAccepts(interpreter, op);
    let status: OpcodeStatus;
    let reason: string;
    if (accepted) {
      status = 'implemented';
      reason = hasHandler ? (GFX_RDP_FORWARD.has(entry) ? 'forwarded to the RDP by the microcode' : 'microcode routine') : 'accepted by the interpreter';
    } else if (!hasHandler) {
      status = 'unsupported-by-design';
      reason = `outside the run of handler addresses of the opcode table (the word read for it, ${h(entry)}, is other data): the microcode has no handler`;
    } else {
      status = 'missing';
      const blank = at(entry - 0x1000).every((l) => /\bnop$/.test(l));
      reason = GFX_RDP_FORWARD.has(entry)
        ? 'the microcode forwards it to the RDP; the interpreter does not model it'
        : blank ? 'the handler address holds only zero words in the text image the task points at (the routine is not in it); the interpreter does not model the opcode'
        : 'the microcode has a routine for it; the interpreter does not';
    }
    table.push({ op, name: gfxName(op), handler: hasHandler ? entry : null, status, reason, head: status === 'missing' && hasHandler ? at(entry - 0x1000) : [] });
  }
  return {
    table, ucode: text, data,
    signature: `dispatch at microcode offset 0x120: sra t4,t9,24; sll t3,t4,1; lhu t3,0x36e(t3); jr t3 (table of halfwords at data offset ${h(GFX_TABLE_BASE)}, indexed by the signed opcode byte)`,
  };
}

/** Whether the audio mixer accepts a command with this opcode. */
export function mixerAccepts(op: number): boolean {
  try {
    const ram = new Uint8Array(0x1000);
    new DataView(ram.buffer).setUint32(0, op * 0x1000000);
    new Synth().run(ram, { list: 0, size: 8, dataSegment: 0 });
  } catch (e) {
    if (/unknown audio command/.test(String(e))) return false;
  }
  return true;
}

export function audioOpcodes(specs: Map<string, ImageSpec>): { table: OpcodeRow[]; ucode: number; data: number; signature: string } {
  const code = specs.get('code')!;
  const text = 0x800e0f10;
  const data = 0x801120e0;
  const dmem = new DataView(code.bytes.buffer, code.bytes.byteOffset + data - code.base, 0x300);
  const listing = disassembleRspRange(code.bytes.subarray(text - code.base, text - code.base + 0x1000), 0);
  const table: OpcodeRow[] = [];
  const names: Record<number, string> = {
    1: 'ADPCM decode', 2: 'clear', 5: 'resample', 7: 'FIR filter', 8: 'set buffers', 9: 'repeat block', 0xa: 'DMEM copy', 0xb: 'load codebook', 0xc: 'mix',
    0xd: 'interleave', 0xe: 'gain', 0xf: 'set loop', 0x10: 'copy runs', 0x11: 'take every other sample', 0x12: 'envelope rates', 0x13: 'envelope mix', 0x14: 'load buffer',
    0x15: 'save buffer', 0x16: 'envelope volumes',
  };
  for (let op = 0; op < 128; op++) {
    const entry = dmem.getUint16(AUDIO_TABLE + 2 * op);
    // The first entry that is not an instruction memory address ends the table; the dispatch masks the opcode to seven bits.
    if (!(entry >= 0x1000 && entry < 0x2000 && (entry & 3) === 0)) break;
    const accepted = mixerAccepts(op);
    table.push({
      op, name: names[op] ?? '', handler: entry, status: accepted ? 'implemented' : 'missing',
      reason: accepted ? 'handled by the mixer' : 'the microcode has a handler; the mixer rejects the command',
      head: accepted ? [] : listing.slice((entry - 0x1000) / 4, (entry - 0x1000) / 4 + 4),
    });
  }
  return { table, ucode: text, data, signature: 'dispatch at microcode offset 0x60: srl at,k0,23; andi at,at,0xfe; lh v0,16(v0); jr v0 (halfword table at data offset 0x10, indexed by the opcode byte)' };
}

// ---- OS routines -------------------------------------------------------------------------------------------------

export interface OsEntry {
  id: string;
  category: string;
  image: string;
  address: number;
  /** replaced: the runtime defines `rt_<id>`; recompiled: the game's own code runs; gap: recompiled but it touches hardware the runtime does not model. */
  disposition: 'replaced' | 'recompiled' | 'gap';
  reason: string;
  /** Number of functions that call it directly. */
  callers: number;
}

const safeName = (s: string) => s.replace(/\W/g, '_');

/** The names `rt_*` that the runtime's C files define. */
export function runtimeReplacements(runtimeDir: string): Set<string> {
  const names = new Set<string>();
  for (const f of readdirSync(runtimeDir).filter((x) => x.endsWith('.c'))) {
    for (const m of readFileSync(join(runtimeDir, f), 'utf8').matchAll(/^(?:void|int|uint32_t|uint64_t) (rt_[A-Za-z0-9_]+)\(Cpu \*c\)/gm)) names.add(m[1]!);
  }
  return names;
}

export interface MmioSite {
  image: string;
  function: number;
  at: number;
  op: string;
  address: number;
  register: string;
  /** 'strict' when the base register is built in the same straight-line run; 'across-branch' when it is carried over a branch. */
  basis: 'strict' | 'across-branch';
  /** The OS routine that contains the site, when the function is one. */
  owner: string | null;
  replaced: boolean;
}

export interface SpecialSite {
  image: string;
  function: number;
  at: number;
  op: string;
  owner: string | null;
  replaced: boolean;
}

export function osRoutines(inv: Inventory, specs: Map<string, ImageSpec>, runtimeDir: string): {
  entries: OsEntry[]; absent: string[]; mmio: MmioSite[]; special: SpecialSite[];
} {
  const routines = (inv.os as { routines: { id: string; category: string; status: string; image: string; addr: number | null }[] }).routines;
  const replacements = runtimeReplacements(runtimeDir);
  const byAddr = new Map<number, { id: string; replaced: boolean }>();
  for (const r of routines) if (r.status === 'found' && r.addr !== null) byAddr.set(r.addr, { id: r.id, replaced: replacements.has(`rt_${safeName(r.id)}`) });

  const calls = new Map<number, number>();
  for (const img of inv.images) for (const f of img.functions) for (const c of new Set(f.calls)) calls.set(c, (calls.get(c) ?? 0) + 1);

  const mmio: MmioSite[] = [];
  const special: SpecialSite[] = [];
  const hardwareByFunction = new Map<number, Set<string>>();
  for (const l of eachFunction(inv, specs)) {
    const owner = byAddr.get(l.fn.start);
    const seen = new Set<string>();
    const strict = new Set<number>();
    for (const pass of [false, true]) {
      for (const { insn, before } of withRegs(l.insns, pass)) {
        if (/^(l[bhwd]u?|lwl|lwr|ldl|ldr|lwu|s[bhwd]|swl|swr|sdl|sdr|lwc1|swc1|ldc1|sdc1|ll|sc)$/.test(insn.op)) {
          const base = before[insn.rs];
          if (base === undefined) continue;
          const ea = (base + ((insn.imm << 16) >> 16)) >>> 0;
          if (!isMmio(ea)) continue;
          if (!pass) strict.add(insn.addr);
          else if (strict.has(insn.addr)) continue;
          const register = registerName(ea & 0x1fffffff);
          seen.add(register);
          mmio.push({ image: l.image, function: l.fn.start, at: insn.addr, op: insn.op, address: ea, register, basis: pass ? 'across-branch' : 'strict', owner: owner?.id ?? null, replaced: owner?.replaced ?? false });
        }
      }
    }
    hardwareByFunction.set(l.fn.start, seen);
    for (const insn of l.insns) {
      if (['mfc0', 'mtc0', 'dmfc0', 'dmtc0', 'cache', 'eret', 'tlbr', 'tlbwi', 'tlbwr', 'tlbp', 'syscall', 'break'].includes(insn.op)) {
        special.push({ image: l.image, function: l.fn.start, at: insn.addr, op: `${insn.op} ${insn.args}`.trim(), owner: owner?.id ?? null, replaced: owner?.replaced ?? false });
      }
    }
  }

  const entries: OsEntry[] = [];
  for (const r of routines) {
    if (r.status !== 'found' || r.addr === null) continue;
    const info = byAddr.get(r.addr)!;
    const touchesHardware = (hardwareByFunction.get(r.addr)?.size ?? 0) > 0 || special.some((s) => s.function === r.addr && s.op.split(' ')[0] !== 'break');
    let disposition: OsEntry['disposition'];
    let reason: string;
    if (info.replaced) {
      disposition = 'replaced';
      reason = `rt_${safeName(r.id)} in the runtime`;
    } else if (touchesHardware) {
      disposition = 'gap';
      reason = `recompiled, but it uses ${[...(hardwareByFunction.get(r.addr) ?? [])].join(', ') || 'COP0, cache or exception instructions'} that the runtime does not model`;
    } else {
      disposition = 'recompiled';
      reason = 'ordinary code over guest memory: the recompiled original runs';
    }
    entries.push({ id: r.id, category: r.category, image: r.image, address: r.addr, disposition, reason, callers: calls.get(r.addr) ?? 0 });
  }
  const absent = routines.filter((r) => r.status !== 'found').map((r) => r.id);
  return { entries, absent, mmio, special };
}

// ---- Recompiler gaps ---------------------------------------------------------------------------------------------

export interface RecompilerGaps {
  functions: number;
  images: number;
  indirectCalls: number;
  indirectCallsResolved: number;
  jumpTables: number;
  /** `jr` instructions that are neither a return nor the dispatch of a recovered jump table. */
  unresolvedJumps: { image: string; function: number; at: number; reg: string }[];
  /** Direct transfers to an address that starts no function. */
  missingTargets: { address: number; from: number[] }[];
  /** Text bytes no function covers, per image with any. */
  uncoveredText: { image: string; bytes: number }[];
  /**
   * Words in the data that hold an address of the image's text but not a function entry. `jumpTableLabels` are the targets of
   * recovered jump tables; the others point into a function (`insideFunction`) or at text no function covers (`outsideFunctions`).
   */
  pointersIntoCode: { jumpTableLabels: number; insideFunction: { image: string; at: number; target: number; function: number }[]; outsideFunctions: { image: string; at: number; target: number }[] };
  imagesWithoutFunctions: string[];
}

export function recompilerGaps(inv: Inventory, specs: Map<string, ImageSpec>): RecompilerGaps {
  const starts = new Set<number>();
  for (const img of inv.images) for (const f of img.functions) starts.add(f.start);
  const gaps: RecompilerGaps = {
    functions: starts.size, images: inv.images.length,
    indirectCalls: inv.images.reduce((n, i) => n + i.indirectCalls.length, 0),
    indirectCallsResolved: inv.images.reduce((n, i) => n + i.indirectCalls.filter((c) => c.targets.length > 0).length, 0),
    jumpTables: inv.images.reduce((n, i) => n + i.jumpTables.length, 0),
    unresolvedJumps: [], missingTargets: [], uncoveredText: [], pointersIntoCode: { jumpTableLabels: 0, insideFunction: [], outsideFunctions: [] }, imagesWithoutFunctions: [],
  };
  const jumpSites = new Set(inv.images.flatMap((i) => i.jumpTables.map((t) => t.site)));
  const missing = new Map<number, number[]>();
  for (const l of eachFunction(inv, specs)) {
    for (const insn of l.insns) {
      if (insn.kind === 'jr' && !jumpSites.has(insn.addr)) gaps.unresolvedJumps.push({ image: l.image, function: l.fn.start, at: insn.addr, reg: insn.args });
    }
    for (const c of l.fn.calls) if (!starts.has(c)) missing.set(c, [...(missing.get(c) ?? []), l.fn.start]);
  }
  gaps.missingTargets = [...missing].map(([address, from]) => ({ address, from })).sort((a, b) => a.address - b.address);
  for (const img of inv.images) {
    const text = img.coverage.find((c) => c.name === '.text');
    if (text && text.unassignedBytes > 0) gaps.uncoveredText.push({ image: img.name, bytes: text.unassignedBytes });
    if (img.functions.length === 0) gaps.imagesWithoutFunctions.push(img.name);
    classifyPointers(img, specs.get(img.name)!, starts, gaps.pointersIntoCode);
  }
  return gaps;
}

function classifyPointers(img: InvImage, spec: ImageSpec, starts: Set<number>, out: RecompilerGaps['pointersIntoCode']): void {
  const text = img.sections.filter((s) => s.kind === 'text');
  const inText = (v: number) => text.some((s) => v >= s.start && v < s.end);
  const labels = new Set(img.jumpTables.flatMap((t) => t.targets));
  const dv = dataWords(spec);
  for (const s of img.sections.filter((x) => x.kind === 'data' || x.kind === 'rodata')) {
    for (let a = s.start; a + 4 <= s.end; a += 4) {
      const v = dv.getUint32(a - spec.base);
      if (!inText(v) || (v & 3) !== 0 || starts.has(v)) continue;
      if (labels.has(v)) { out.jumpTableLabels++; continue; }
      const owner = img.functions.find((f) => f.start < v && v < f.end);
      if (owner) out.insideFunction.push({ image: img.name, at: a, target: v, function: owner.start });
      else out.outsideFunctions.push({ image: img.name, at: a, target: v });
    }
  }
}

// ---- Scene and entrance tables -----------------------------------------------------------------------------------

export interface EntranceEntry {
  index: number;
  scene: number;
  spawn: number;
  /** The scene index names a record of the scene table. */
  valid: boolean;
}

export interface SceneTables {
  sceneRecords: number;
  entrances: EntranceEntry[];
}

/** The entrance table (4-byte entries ending where the scene table starts) and the number of valid scene records. */
export function sceneTables(ctx: RomContext, specs: Map<string, ImageSpec>): SceneTables {
  const code = specs.get('code')!;
  const dv = dataWords(code);
  const starts = new Set(ctx.files.map((f) => f.virtualStart));
  // A record names a file range of the cartridge: an existing file's start and an end after it.
  const validRecord = (n: number) => {
    const start = dv.getUint32(SCENE_TABLE - code.base + n * 20);
    const end = dv.getUint32(SCENE_TABLE - code.base + n * 20 + 4);
    return starts.has(start) && start < end;
  };
  let sceneRecords = 0;
  while (validRecord(sceneRecords)) sceneRecords++;
  const entrances: EntranceEntry[] = [];
  for (let i = 0; i < ENTRANCE_COUNT; i++) {
    const scene = dv.getInt8(ENTRANCE_TABLE - code.base + i * 4);
    entrances.push({ index: i, scene, spawn: dv.getInt8(ENTRANCE_TABLE - code.base + i * 4 + 1), valid: scene >= 0 && scene < sceneRecords });
  }
  return { sceneRecords, entrances };
}

// ---- Everything -------------------------------------------------------------------------------------------------

export interface StaticSweep {
  tasks: ReturnType<typeof rspTasks>;
  microcodes: MicrocodeText[];
  graphics: ReturnType<typeof graphicsOpcodes>;
  audio: ReturnType<typeof audioOpcodes>;
  os: ReturnType<typeof osRoutines>;
  recompiler: RecompilerGaps;
  scenes: SceneTables;
  /** Entry addresses of the functions of each image, for the coverage figures. */
  functionsByImage: { image: string; kind: InvImage['kind']; starts: number[] }[];
}

export function staticSweep(ctx: RomContext, inv: Inventory, runtimeDir: string, interpreter: CDisplayListInterpreter): StaticSweep {
  const specs = new Map(buildSpecs(ctx).map((s) => [s.name, s]));
  return {
    tasks: rspTasks(inv, specs), microcodes: microcodeTexts(inv, specs), graphics: graphicsOpcodes(specs, interpreter), audio: audioOpcodes(specs), os: osRoutines(inv, specs, runtimeDir),
    recompiler: recompilerGaps(inv, specs), scenes: sceneTables(ctx, specs),
    functionsByImage: inv.images.map((i) => ({ image: i.name, kind: i.kind, starts: i.functions.map((f) => f.start) })),
  };
}
