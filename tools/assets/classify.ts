// Classifies every file of the file table (and the ROM bytes outside it) from how the game's code and data refer to it.
import type { RomContext } from '../analyze/context.ts';
import type { Inventory } from '../analyze/types.ts';
import type { FileEntry } from '../rom/filetable.ts';
import { findAudioTables, type AudioTable } from './audio.ts';
import { scanDisplayLists } from './dlscan.ts';
import { addressRefs, codeImages, constantSites, literalRefs, loadCallAfter, type CodeImage, type LiteralRef } from './refs.ts';
import { readCommands, readMesh, readObjectList, roomList, type SceneCommand } from './scene.ts';
import { findAnimations, findSkeletons } from './skeleton.ts';
import { findRangeTables, type RangeTable } from './tables.ts';
import { knowledgeFor } from './knowledge.ts';

export type AssetType =
  | 'code' | 'overlay' | 'scene' | 'room' | 'object' | 'texture'
  | 'audio-bank' | 'sequence' | 'sample-table' | 'animation' | 'text' | 'other' | 'unknown';

export type Confidence = 'high' | 'medium' | 'low';

export interface AssetEntry {
  /** Index in the file table, or -1 for ROM bytes outside every file. */
  file: number;
  type: AssetType;
  /** What the entry is, in words that follow from the evidence. */
  label: string;
  confidence: Confidence;
  /** Stored bytes in the ROM. */
  romStart: number;
  romEnd: number;
  /** Address range of the decompressed file. */
  virtualStart: number;
  virtualEnd: number;
  compressed: boolean;
  evidence: string[];
  /** Why the entry has no type; set only for `unknown`. */
  reason?: string;
  /** Structures found inside the file, offsets relative to the decompressed file. */
  contents?: Record<string, unknown>;
}

export interface TableInfo {
  /** Offset in the main code file and the address it is loaded at. */
  offset: number;
  ram: number;
  stride: number;
  records: number;
  role: string;
  fields: number[];
  readers: number[];
}

export interface Classification {
  entries: AssetEntry[];
  tables: TableInfo[];
}

const hex = (n: number) => '0x' + (n >>> 0).toString(16);
const MAX_SITES = 4;
const sites = (addrs: (number | string)[]) => addrs.slice(0, MAX_SITES).map((a) => (typeof a === 'number' ? hex(a) : a)).join(', ') + (addrs.length > MAX_SITES ? ', …' : '');

export function classify(ctx: RomContext, inventory: Inventory): Classification {
  const images = codeImages(ctx, inventory);
  const codeImage = images[0]!;
  const dataFrom = textSize(inventory);
  const codeBytes = codeImage.bytes;
  const refs = literalRefs(images, ctx.files);
  const loaders = new Set([ctx.layout.code.loaderAddr, ...DMA_ENTRY]);

  const entries = new Map<number, AssetEntry>();
  for (const f of ctx.files) {
    entries.set(f.index, {
      file: f.index, type: 'unknown', label: 'unclassified', confidence: 'low', romStart: f.romStart, romEnd: f.romEnd,
      virtualStart: f.virtualStart, virtualEnd: f.virtualEnd, compressed: f.compressed,
      evidence: [`file table record ${f.index}: virtual ${hex(f.virtualStart)}-${hex(f.virtualEnd)}, ROM ${hex(f.romStart)}-${hex(f.romEnd)}${f.compressed ? ', Yaz0' : ', stored'}`],
    });
  }
  const typed = new Set<number>();
  /** Sets the type of a file once; a later rule that disagrees only adds its evidence. */
  const assign = (file: number, type: AssetType, label: string, confidence: Confidence, evidence: string[], contents?: Record<string, unknown>) => {
    const e = entries.get(file)!;
    if (typed.has(file)) {
      e.evidence.push(...evidence.map((x) => `also: ${x}`));
      return;
    }
    typed.add(file);
    Object.assign(e, { type, label, confidence });
    e.evidence.push(...evidence);
    if (contents) e.contents = contents;
  };

  // ---- Layout: boot code, main code, code segments and overlays ----
  const { boot, code } = ctx.layout;
  assign(0, 'other', 'ROM header, boot-loader area and the first bytes of the boot code image', 'high', [
    `header word 0x08 = ${hex(boot.entry)}; the IPL copies ROM ${hex(boot.romOffset)} onward to RAM ${hex(boot.ramStart)}`,
  ]);
  assign(1, 'code', 'boot code', 'high', [
    `part of the boot image ROM ${hex(boot.romOffset)}-${hex(boot.romOffset + boot.ramEnd - boot.ramStart)} loaded at ${hex(boot.ramStart)}, entry ${hex(boot.entry)}`,
    ...boot.evidence.slice(0, 3),
  ]);
  const rangeTables = findRangeTables(codeBytes, dataFrom, ctx.files);
  const fileTable = ctx.files[2]!;
  assign(2, 'other', 'file table', 'high', [`the table of 16-byte file records starts at the first byte of this file (ROM ${hex(fileTable.romStart)}) and lies inside it`]);
  assign(code.fileIndex, 'code', 'main code file', 'high', [
    `loaded at ${hex(code.ramStart)} by the boot code at ${hex(code.loadCallAddr)} through the loader ${hex(code.loaderAddr)}`,
    ...code.evidence.slice(0, 2),
  ], { ram: code.ramStart, entry: code.entry, bss: [code.bss.start, code.bss.size] });
  for (const s of ctx.layout.segments) {
    assign(s.fileIndex, 'code', 'code segment', 'high', [...s.evidence.slice(0, 2)], { ram: s.ramStart, entry: s.entry, bss: [s.bss.start, s.bss.size] });
  }

  // ---- Tables of file ranges in the main code file ----
  const tableInfos: TableInfo[] = [];
  const tableRoles = new Map<RangeTable, string>();
  const describeTable = (t: RangeTable, role: string): TableInfo => {
    const ram = code.ramStart + t.offset;
    const readers = addressRefs(codeImage, ram, ram + t.records * t.stride);
    const info: TableInfo = { offset: t.offset, ram, stride: t.stride, records: t.records, role, fields: [...new Set(t.members.map((m) => m.field))], readers };
    tableInfos.push(info);
    return info;
  };
  const tableText = (t: RangeTable, info: TableInfo, m: { record: number; field: number }) =>
    `record ${m.record}${t.stride > 8 ? ` field +${m.field}` : ''} of the ${t.records}-record, ${t.stride}-byte-stride table at code file +${hex(t.offset)} (RAM ${hex(info.ram)})${info.readers.length ? `, read by code at ${sites(info.readers)}` : ''}`;

  const overlayFiles = new Set(ctx.layout.overlays.map((o) => o.fileIndex));
  const memberTables = rangeTables.filter((t) => t.members.some((m) => overlayFiles.has(m.file)));
  for (const t of memberTables) {
    describeTable(t, 'overlay descriptors');
    tableRoles.set(t, 'overlay');
  }
  for (const o of ctx.layout.overlays) {
    const t = memberTables.find((x) => x.members.some((m) => m.file === o.fileIndex));
    const m = t?.members.find((x) => x.file === o.fileIndex);
    const info = t && tableInfos.find((i) => i.offset === t.offset)!;
    assign(o.fileIndex, 'overlay', `code overlay linked at ${hex(o.vramStart)}`, 'high', [
      `text, data and rodata of ${o.textSize + o.dataSize + o.rodataSize} bytes followed by ${o.relocs.length} relocations and a size footer (docs/re/overlays.md)`,
      ...(t && m && info ? [tableText(t, info, m)] : []),
    ], {
      link: [o.vramStart, o.vramEnd], text: o.textSize, data: o.dataSize, rodata: o.rodataSize, bss: o.bssSize, relocations: o.relocs.length,
      ...(m && t ? { table: { offset: t.offset, record: m.record } } : {}),
    });
  }

  // ---- Audio ----
  const audio = findAudioTables(codeBytes, dataFrom, ctx.files, (i) => ctx.fileBytes(i));
  const audioDone = new Set<number>();
  for (const a of audio) classifyAudio(a, assign, ctx, codeImage, audioDone);

  // ---- Scenes, title cards and rooms ----
  const otherTables = rangeTables.filter((t) => !tableRoles.has(t));
  const scenesByTable = new Map<RangeTable, number>();
  for (const t of otherTables) {
    const first = t.members.filter((m) => m.field === 0);
    const ok = first.filter((m) => {
      const c = readCommands(ctx.fileBytes(m.file));
      return c !== null && roomList(ctx.fileBytes(m.file), c, ctx.files).length > 0;
    });
    if (first.length >= 10 && ok.length >= first.length * 0.9) scenesByTable.set(t, ok.length);
  }
  const sceneTable = [...scenesByTable.keys()][0];
  const sceneFiles: number[] = [];
  if (sceneTable) {
    const info = describeTable(sceneTable, 'scenes');
    tableRoles.set(sceneTable, 'scene');
    const titleField = sceneTable.members.find((m) => m.field !== 0)?.field;
    for (const m of sceneTable.members) {
      if (m.field === 0) {
        sceneFiles.push(m.file);
        const bytes = ctx.fileBytes(m.file);
        const commands = readCommands(bytes)!;
        const rooms = roomList(bytes, commands, ctx.files);
        assign(m.file, 'scene', 'scene', 'high', [
          tableText(sceneTable, info, m),
          `starts with a ${commands.length}-command list ending with command ${hex(0x14)}; a command lists ${rooms.length} room files as (virtual start, virtual end) pairs at scene offset ${hex(rooms[0]!.at)}`,
        ], sceneContents(bytes, commands, rooms.map((r) => r.file), 2));
      } else if (m.field === titleField) {
        assign(m.file, 'texture', 'scene title card image', 'medium', [
          tableText(sceneTable, info, m),
          'the other range of a scene record, next to the scene file; its bytes hold no commands or display lists',
        ], { role: 'title card' });
      }
    }
  }
  // The object table is the largest of the remaining range tables; rooms name their objects by record number in it.
  const objectTable = otherTables.filter((t) => !tableRoles.has(t)).sort((a, b) => b.members.length - a.members.length)[0];
  const hasObjects = objectTable !== undefined && objectTable.members.length >= 100;
  const objectFile = new Map(hasObjects ? objectTable.members.map((m) => [m.record, m.file]) : []);
  const objectUsers = new Map<number, number>();
  for (const sceneFile of sceneFiles) {
    const bytes = ctx.fileBytes(sceneFile);
    const commands = readCommands(bytes)!;
    for (const r of roomList(bytes, commands, ctx.files)) {
      const room = ctx.fileBytes(r.file);
      const rc = readCommands(room);
      const contents = rc ? roomContents(room, rc, objectTable?.records ?? 0, objectFile) : undefined;
      for (const id of (contents?.objects as number[] | undefined) ?? []) objectUsers.set(id, (objectUsers.get(id) ?? 0) + 1);
      assign(r.file, 'room', 'room', rc ? 'high' : 'medium', [
        `listed by scene file ${sceneFile} at scene offset ${hex(r.at)} (room list command)`,
        rc ? `starts with a ${rc.length}-command list ending with command ${hex(0x14)}` : 'does not start with a command list',
      ], contents);
    }
  }

  // ---- Objects ----
  if (hasObjects) {
    const info = describeTable(objectTable, 'objects');
    tableRoles.set(objectTable, 'object');
    const count = new DataView(codeBytes.buffer, codeBytes.byteOffset, codeBytes.byteLength).getUint32(objectTable.offset - 4);
    for (const m of objectTable.members) {
      const bytes = ctx.fileBytes(m.file);
      assign(m.file, 'object', `object ${m.record}`, 'high', [
        tableText(objectTable, info, m),
        ...(count === objectTable.records ? [`the word before the table holds ${count}, its record count`] : []),
        ...(objectUsers.get(m.record) ? [`named by the object lists of ${objectUsers.get(m.record)} rooms (an object list holds record numbers of this table)`] : []),
      ], objectContents(bytes, m.record));
    }
  }

  // ---- Image and palette pairs ----
  const textureTables = otherTables.filter((t) => !tableRoles.has(t) && t.stride === 8 && t.members.length >= 4);
  for (const t of textureTables) {
    const info = describeTable(t, 'image and palette ranges');
    tableRoles.set(t, 'texture');
    const sorted = [...t.members].sort((a, b) => a.record - b.record);
    sorted.forEach((m, k) => {
      const palette = k % 2 === 1;
      const partner = sorted[palette ? k - 1 : k + 1];
      assign(m.file, 'texture', palette ? 'palette' : 'image', 'medium', [
        tableText(t, info, m),
        `records alternate image and palette: this is ${palette ? 'the palette of' : 'the image of'} the pair with file ${partner?.file}`,
      ], { role: palette ? 'palette' : 'image', pair: partner?.file });
    });
    const last = sorted.at(-1)!.file;
    continueTexturePairs(last, ctx, refs, info.readers, assign, typed);
  }

  // ---- Hand-checked files ----
  for (const f of ctx.files) {
    if (typed.has(f.index)) continue;
    const k = knowledgeFor(f.virtualStart);
    if (!k) continue;
    const found = k.sites.every((s) => (refs.get(f.index) ?? []).some((r) => r.addr === s.addr && r.image === s.image));
    if (!found) continue;
    assign(f.index, k.type, k.label, k.confidence, [...k.evidence, `code sites: ${sites(k.sites.map((s) => s.addr))}`], k.contents);
  }

  // ---- Text by content ----
  for (const f of ctx.files) {
    if (typed.has(f.index) || f.virtualEnd - f.virtualStart < 0x100) continue;
    const bytes = ctx.fileBytes(f.index);
    const text = printableShare(bytes);
    if (text >= 0.6 && (refs.get(f.index)?.length ?? 0) > 0) {
      assign(f.index, 'text', 'character data', 'medium', [
        `${Math.round(text * 100)}% of the bytes are printable ASCII`,
        `named by code at ${sites((refs.get(f.index) ?? []).map((r) => r.addr))}`,
      ], { printable: Number(text.toFixed(3)) });
    }
  }

  // ---- What is left ----
  for (const f of ctx.files) {
    if (typed.has(f.index)) continue;
    const e = entries.get(f.index)!;
    const bytes = ctx.fileBytes(f.index);
    e.reason = unknownReason(f, bytes, refs.get(f.index) ?? [], images, loaders);
    e.label = 'no structure identified';
  }

  // ---- ROM bytes outside every file ----
  const out = [...entries.values()];
  let at = 0;
  for (const f of [...ctx.files].sort((x, y) => x.romStart - y.romStart)) {
    if (f.romStart > at) out.push(outside(ctx.rom, at, f.romStart));
    at = Math.max(at, f.romEnd);
  }
  if (at < ctx.rom.length) out.push(outside(ctx.rom, at, ctx.rom.length));
  return { entries: out.sort((a, b) => a.romStart - b.romStart || a.file - b.file), tables: tableInfos.sort((a, b) => a.offset - b.offset) };
}

/** Entry points of the DMA request routines the game's loaders go through (boot code, docs/re/os-routines.md). */
const DMA_ENTRY = [0x80000e68, 0x80000f30];

function textSize(inventory: Inventory): number {
  const text = inventory.images.find((i) => i.name === 'code')?.sections.find((s) => s.kind === 'text');
  const data = inventory.images.find((i) => i.name === 'code')?.sections.find((s) => s.kind === 'data');
  if (!text || !data) throw new Error('inventory has no sections for the main code file');
  return data.start - text.start;
}

function printableShare(bytes: Uint8Array): number {
  let n = 0;
  for (const b of bytes) if ((b >= 0x20 && b < 0x7f) || b === 0x0a || b === 0x0d) n++;
  return n / bytes.length;
}

function outside(rom: Uint8Array, start: number, end: number): AssetEntry {
  return {
    file: -1, type: 'other', label: 'ROM bytes outside the file table', confidence: 'medium', romStart: start, romEnd: end,
    virtualStart: start, virtualEnd: end, compressed: false,
    evidence: [`${hex(start)}-${hex(end)} is covered by no file-table record`, bytePattern(rom.subarray(start, end))],
  };
}

function bytePattern(bytes: Uint8Array): string {
  let step = 0;
  while (step < bytes.length && step < 256 && bytes[step] === ((bytes[0] ?? 0) + step) % 256) step++;
  const zero = bytes.reduce((n, b) => n + (b === 0 ? 1 : 0), 0);
  return `the first ${step} bytes count up from ${hex(bytes[0] ?? 0)}; ${zero} of ${bytes.length} bytes are zero`;
}


type Assign = (file: number, type: AssetType, label: string, confidence: Confidence, evidence: string[], contents?: Record<string, unknown>) => void;

function classifyAudio(a: AudioTable, assign: Assign, ctx: RomContext, codeImage: CodeImage, done: Set<number>): void {
  if (done.has(a.file)) return;
  done.add(a.file);
  const f = ctx.files[a.file]!;
  const ram = ctx.layout.code.ramStart + a.offset;
  const readers = addressRefs(codeImage, ram, ram + 16 + a.entries.length * 16);
  const romSites = constantSites(codeImage, f.romStart);
  const head = `${a.entries.length} entries (${a.ranges} with data) at code file +${hex(a.offset)} (RAM ${hex(ram)}) whose offset and size fields address this file; the last range ends ${hex(f.virtualEnd - f.virtualStart - Math.max(...a.entries.filter((e) => e.size > 0).map((e) => e.offset + e.size)))} before its end`;
  const evidence = [head, `the audio set-up passes the table and the ROM address ${hex(f.romStart)} of this file together${romSites.length ? ` (code at ${sites(romSites)})` : ''}`];
  if (readers.length) evidence.push(`table read by code at ${sites(readers)}`);
  const ranges = a.entries.map((e) => [e.offset, e.size]);
  if (a.kind === 'audio-bank') {
    assign(a.file, 'audio-bank', 'instrument bank file', 'high', [...evidence, 'every entry starts with offsets that all lie inside the entry'], { entries: ranges, table: a.offset });
  } else if (a.kind === 'sequence') {
    assign(a.file, 'sequence', 'sequence file', 'high', [...evidence, `a map at code file +${hex(a.fontMap)} holds one list of bank numbers per entry (${a.entries.length} lists, every number below the bank count)`], { entries: ranges, table: a.offset, bankMap: a.fontMap });
  } else {
    assign(a.file, 'sample-table', 'sample data file', 'medium', [...evidence, 'the remaining audio table: its ranges are not banks and no per-entry bank map exists'], { entries: ranges, table: a.offset });
  }
}

function sceneContents(bytes: Uint8Array, commands: SceneCommand[], rooms: number[], segment: number): Record<string, unknown> {
  const scan = scanDisplayLists(bytes, segment);
  return { segment, commands: commands.map((c) => [c.id, c.operand, c.value]), rooms, ...compactScan(scan) };
}

function roomContents(bytes: Uint8Array, commands: SceneCommand[], objectCount: number, objectFile: Map<number, number>): Record<string, unknown> {
  const scan = scanDisplayLists(bytes, 3);
  const mesh = readMesh(bytes, commands, scan.lists);
  const objects = readObjectList(bytes, commands, objectCount);
  return {
    segment: 3, commands: commands.map((c) => [c.id, c.operand, c.value]),
    ...(mesh ? { mesh: { command: mesh.command, offset: mesh.offset, type: mesh.type, entries: mesh.entries } } : {}),
    ...(objects ? { objectCommand: objects.command, objects: objects.ids, objectFiles: objects.ids.map((id) => objectFile.get(id) ?? -1) } : {}),
    ...compactScan(scan),
  };
}

function objectContents(bytes: Uint8Array, id: number): Record<string, unknown> {
  const scan = scanDisplayLists(bytes, 6);
  const skeletons = findSkeletons(bytes, 6, scan.lists);
  const seen = new Map<number, ReturnType<typeof findAnimations>[number]>();
  for (const s of skeletons) for (const a of findAnimations(bytes, 6, s.limbCount)) seen.set(a.offset, a);
  return {
    segment: 6, objectId: id, ...compactScan(scan),
    skeletons: skeletons.map((s) => ({ offset: s.offset, limbTable: s.limbTable, limbs: s.limbCount })),
    animations: [...seen.values()].map((a) => [a.offset, a.frames, a.frameData, a.jointIndices, a.staticIndexMax]),
  };
}

function compactScan(scan: ReturnType<typeof scanDisplayLists>): Record<string, unknown> {
  return {
    displayLists: scan.lists.map((l) => [l.start, l.end]),
    vertices: scan.vertices.map((v) => [v.offset, v.count]),
    textures: scan.textures.map((t) => [t.offset, t.fmt, t.siz, t.width, t.height, t.palette, t.bytes]),
    palettes: scan.palettes.map((p) => [p.offset, p.entries]),
    matrices: scan.matrices,
    foreignSegments: scan.foreignSegments,
  };
}

/**
 * Image/palette pairs that continue after the table: compressed image followed by a small stored palette, named by
 * literals in code that sit next to the readers of the table.
 */
function continueTexturePairs(after: number, ctx: RomContext, refs: Map<number, LiteralRef[]>, readers: number[], assign: Assign, typed: Set<number>): void {
  if (readers.length === 0) return;
  const lo = Math.min(...readers) - 0x1000, hi = Math.max(...readers) + 0x1000;
  for (let i = after + 1; i + 1 < ctx.files.length; i += 2) {
    const img = ctx.files[i]!, pal = ctx.files[i + 1]!;
    const near = (refs.get(i) ?? []).filter((r) => r.image === 'code' && r.addr >= lo && r.addr <= hi);
    if (typed.has(i) || near.length === 0 || !img.compressed || pal.compressed || pal.virtualEnd - pal.virtualStart > 0x800) break;
    assign(i, 'texture', 'image', 'medium', [`named by code at ${sites(near.map((r) => r.addr))}, next to the readers of the image table; same layout as its records: compressed image, then a stored palette`], { role: 'image', pair: i + 1 });
    assign(i + 1, 'texture', 'palette', 'medium', [`follows image file ${i} the way the palette follows the image in the table's records`], { role: 'palette', pair: i });
  }
}

function unknownReason(f: FileEntry, bytes: Uint8Array, refs: LiteralRef[], images: CodeImage[], loaders: Set<number>): string {
  const size = f.virtualEnd - f.virtualStart;
  const zero = bytes.reduce((n, b) => n + (b === 0 ? 1 : 0), 0);
  if (zero === bytes.length) return `all ${size} bytes are zero and no table or code names the file`;
  const parts: string[] = [];
  const byImage = new Map(images.map((i) => [i.name, i]));
  const calls = refs.map((r) => ({ r, call: loadCallAfter(byImage.get(r.image)!, r.addr, loaders) }));
  const sizes = [...new Set(calls.flatMap((c) => {
    const a = c.call?.args;
    return a ? [a[c.call!.callee === DMA_ENTRY[0] ? 3 : 2]].filter((v): v is number => v !== undefined && v > 0 && v <= size) : [];
  }))];
  if (refs.length > 0) {
    parts.push(`named by code at ${sites(refs.map((r) => `${r.image}:${hex(r.addr)}`))}`);
    if (sizes.length > 0) parts.push(`read in blocks of ${sizes.map(hex).join(' or ')} bytes`);
    else parts.push('the transfer size is not a constant at the call');
  } else parts.push('no table or code names it');
  parts.push(`${Math.round((100 * zero) / bytes.length)}% zero bytes; the content matches no scene, room, object, texture or audio layout`);
  return parts.join('; ');
}
