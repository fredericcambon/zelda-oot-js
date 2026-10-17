import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContext } from '../analyze/context.ts';
import { analyze } from '../analyze/run.ts';
import { Op } from '../gfx/opcodes.ts';
import type { FileEntry } from '../rom/filetable.ts';
import { classify, type AssetEntry } from './classify.ts';
import { findDisplayLists, scanDisplayLists } from './dlscan.ts';
import { readCommands, roomList } from './scene.ts';
import { findAnimations, findSkeletons } from './skeleton.ts';
import { findRangeTables } from './tables.ts';
import { sha1Hex } from '../rom/rom.ts';
import { packImage, unpackImage } from './pack.ts';
import { buildManifest, readCartridge, tilingProblem, writeAssets } from './write.ts';

function words(...w: number[]): Uint8Array {
  const out = new Uint8Array(w.length * 4);
  const dv = new DataView(out.buffer);
  w.forEach((x, i) => dv.setUint32(i * 4, x >>> 0));
  return out;
}

const file = (index: number, virtualStart: number, size: number): FileEntry => ({
  index, virtualStart, virtualEnd: virtualStart + size, romStart: virtualStart, romEnd: virtualStart + size, compressed: false,
});

describe('tilingProblem', () => {
  it('accepts entries that tile the image', () => {
    expect(tilingProblem([{ romStart: 0, romEnd: 16 }, { romStart: 16, romEnd: 32 }], 32)).toBeUndefined();
  });
  it('reports a gap, an overlap and a short image', () => {
    expect(tilingProblem([{ romStart: 0, romEnd: 16 }, { romStart: 20, romEnd: 32 }], 32)).toMatch(/covered by no entry/);
    expect(tilingProblem([{ romStart: 0, romEnd: 20 }, { romStart: 16, romEnd: 32 }], 32)).toMatch(/covered twice/);
    expect(tilingProblem([{ romStart: 0, romEnd: 16 }], 32)).toMatch(/end at/);
  });
});

describe('findRangeTables', () => {
  const files = [file(0, 0x1000, 0x100), file(1, 0x2000, 0x200), file(2, 0x3000, 0x300), file(3, 0x4000, 0x400)];
  // Records of 12 bytes: start, end, a flag word. The third record is unused.
  const data = words(
    0x1000, 0x1100, 7,
    0x2000, 0x2200, 8,
    0, 0, 0,
    0x3000, 0x3300, 9,
    0x4000, 0x4400, 1,
  );
  it('finds records that hold a file range, skipping an unused record', () => {
    const [t] = findRangeTables(data, 0, files);
    expect(t).toMatchObject({ offset: 0, stride: 12, records: 5 });
    expect(t!.members.map((m) => [m.record, m.file])).toEqual([[0, 0], [1, 1], [3, 2], [4, 3]]);
  });
});

describe('display lists', () => {
  const cmd = (op: number, w1 = 0, low = 0) => [(op << 24 | low) >>> 0, w1 >>> 0];
  const list = [...cmd(Op.RDPPIPESYNC), ...cmd(Op.SETPRIMCOLOR, 0xff00ff00), ...cmd(Op.ENDDL)];

  it('finds a list that something points to even when look-alike data precedes it', () => {
    // Four plausible-looking commands of data, then the list at 0x20; a pointer in the file names 0x20.
    const garbage = [...cmd(Op.RDPTILESYNC), ...cmd(Op.SETPRIMCOLOR, 1), ...cmd(Op.RDPLOADSYNC), ...cmd(Op.SETENVCOLOR, 2)];
    const bytes = new Uint8Array([...words(...garbage, ...list), ...words(0x06000020)]);
    const lists = findDisplayLists(bytes.subarray(0, bytes.length), 6);
    expect(lists).toContainEqual({ start: 0x20, end: 0x38 });
  });

  it('ignores runs that do not end with a terminator', () => {
    expect(findDisplayLists(words(...cmd(Op.RDPPIPESYNC), ...cmd(Op.RDPTILESYNC), ...cmd(Op.RDPLOADSYNC)), 6)).toEqual([]);
  });

  it('reads a texture, its palette and a vertex array from the commands that name them', () => {
    const settimg = (fmt: number, siz: number, addr: number) => cmd(Op.SETTIMG, addr, (fmt << 21 | siz << 19 | 31) >>> 0);
    const settile = (fmt: number, siz: number, tile: number) => cmd(Op.SETTILE, tile << 24, (fmt << 21 | siz << 19) >>> 0);
    const bytes = new Uint8Array(0x400);
    const dl = words(
      ...settimg(2, 2, 0x06000100),
      ...settile(0, 2, 7),
      ...cmd(Op.LOADTLUT, 7 << 24 | 15 << 14),
      ...settimg(2, 0, 0x06000200),
      ...settile(2, 0, 7),
      ...cmd(Op.LOADBLOCK, 7 << 24 | 0x7ff << 12),
      ...settile(2, 0, 0),
      ...cmd(Op.SETTILESIZE, 31 << 14 | 31 << 2),
      ...cmd(Op.VTX, 0x06000300, 4 << 12 | 4 << 1),
      ...cmd(Op.ENDDL),
    );
    bytes.set(dl);
    const scan = scanDisplayLists(bytes, 6);
    expect(scan.lists).toEqual([{ start: 0, end: dl.length }]);
    expect(scan.textures).toEqual([{ offset: 0x200, fmt: 2, siz: 0, width: 32, height: 32, palette: 0x100, bytes: 512 }]);
    expect(scan.palettes).toEqual([{ offset: 0x100, entries: 16 }]);
    expect(scan.vertices).toEqual([{ offset: 0x300, count: 4 }]);
  });
});

describe('scene headers', () => {
  const header = words(0x04020000, 0x02000010, 0x14000000, 0, 0x00200000, 0x00200100, 0x00300000, 0x00300200);
  it('reads the command list up to the end command', () => {
    expect(readCommands(header)).toEqual([{ id: 4, operand: 2, value: 0x02000010 }, { id: 0x14, operand: 0, value: 0 }]);
  });
  it('rejects bytes that are not a command list', () => {
    expect(readCommands(words(0xff000000, 0))).toBeNull();
    expect(readCommands(words(0x01000000, 0))).toBeNull();
  });
  it('resolves the room list to files of the file table', () => {
    const files = [file(0, 0x200000, 0x100), file(1, 0x300000, 0x200)];
    const commands = readCommands(header)!;
    expect(roomList(header, commands, files)).toEqual([{ file: 0, at: 0x10 }, { file: 1, at: 0x18 }]);
  });
});

describe('skeletons and animations', () => {
  // Layout: header at 0 (limb table 0x06000010, 2 limbs), table at 0x10, limbs at 0x18 and 0x24, a list at 0x30,
  // an animation header at 0x50 with its index triples at 0x70 and frame values at 0x90.
  const bytes = new Uint8Array(0x100);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, 0x06000010); dv.setUint8(4, 2);
  dv.setUint32(0x10, 0x06000018); dv.setUint32(0x14, 0x06000024);
  bytes.set([0, 0, 0, 0, 0, 0, 1, 0xff], 0x18); dv.setUint32(0x20, 0x06000030);
  bytes.set([0, 0, 0, 0, 0, 0, 0xff, 0xff], 0x24); dv.setUint32(0x2c, 0);
  bytes.set(words(0xe7000000, 0, 0xd9ffffff, 0, 0xdf000000, 0), 0x30);
  dv.setInt16(0x50, 4); dv.setUint32(0x54, 0x06000090); dv.setUint32(0x58, 0x06000070); dv.setUint16(0x5c, 3);
  [0, 3, 3, 3, 3, 3, 3, 3, 3].forEach((v, i) => dv.setUint16(0x70 + i * 2, v));

  it('finds a limb table whose limbs link by index and whose lists exist', () => {
    const lists = findDisplayLists(bytes, 6);
    const [s] = findSkeletons(bytes, 6, lists);
    expect(s).toMatchObject({ offset: 0, limbTable: 0x10, limbCount: 2 });
    expect(s!.limbs.map((l) => [l.child, l.sibling, l.list])).toEqual([[1, 0xff, 0x30], [0xff, 0xff, -1]]);
  });

  it('finds an animation whose index triples fit the frame data', () => {
    expect(findAnimations(bytes, 6, 2)).toContainEqual({ offset: 0x50, frames: 4, frameData: 0x90, jointIndices: 0x70, staticIndexMax: 3 });
  });
});

describe('assets on disk', () => {
  it('rebuilds the image from the files the manifest names', () => {
    const rom = Uint8Array.from({ length: 64 }, (_, i) => i * 3);
    const entry = (file: number, romStart: number, romEnd: number, type: AssetEntry['type']): AssetEntry => ({
      file, type, label: '', confidence: 'high', romStart, romEnd, virtualStart: romStart, virtualEnd: romEnd, compressed: false, evidence: [],
    });
    const manifest = buildManifest('sha', 64, { tables: [], entries: [entry(0, 0, 40, 'code'), entry(1, 40, 64, 'unknown')] });
    const dir = mkdtempSync(join(tmpdir(), 'oot-assets-'));
    try {
      writeAssets(rom, manifest, dir);
      expect(readCartridge(dir)).toEqual(rom);
      expect(manifest.summary.code).toEqual({ files: 1, bytes: 40 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses entries that leave part of the image uncovered', () => {
    const e: AssetEntry = { file: 0, type: 'code', label: '', confidence: 'high', romStart: 0, romEnd: 8, virtualStart: 0, virtualEnd: 8, compressed: false, evidence: [] };
    expect(() => buildManifest('sha', 16, { tables: [], entries: [e] })).toThrow(/do not tile/);
  });
});

const rom = process.env.OOT_ROM;

describe.skipIf(!rom || !existsSync(rom))('classification of the ROM', () => {
  it('types every file of the file table, lists the rest as unknown with a reason, and keeps the bytes', async () => {
    const work = resolve('out', 'assets-test');
    const inventory = await analyze({ romPath: rom!, outDir: work, workDir: join(work, 'work'), useGhidra: false });
    const ctx = loadContext(rom!);
    const result = classify(ctx, inventory);

    const files = result.entries.filter((e) => e.file >= 0);
    expect(files.map((e) => e.file).sort((a, b) => a - b)).toEqual(ctx.files.map((f) => f.index));
    for (const e of files) expect(e.evidence.length, `file ${e.file}`).toBeGreaterThan(0);
    for (const e of result.entries.filter((x) => x.type === 'unknown')) expect(e.reason, `file ${e.file}`).toMatch(/\S/);

    const count = (t: AssetEntry['type']) => result.entries.filter((e) => e.type === t).length;
    expect(count('overlay')).toBe(ctx.layout.overlays.length);
    expect(count('scene')).toBeGreaterThanOrEqual(90);
    expect(count('room')).toBeGreaterThanOrEqual(300);
    expect(count('object')).toBeGreaterThanOrEqual(300);
    expect(count('texture')).toBeGreaterThanOrEqual(100);
    expect(count('audio-bank')).toBe(1);
    expect(count('sequence')).toBe(1);
    expect(count('sample-table')).toBe(1);
    expect(count('unknown')).toBeLessThan(60);

    // Every room names its scene, and a room's object list resolves to object files.
    const rooms = result.entries.filter((e) => e.type === 'room' && e.contents?.objectFiles);
    expect(rooms.length).toBeGreaterThan(300);
    for (const r of rooms) for (const f of r.contents!.objectFiles as number[]) expect(result.entries.find((e) => e.file === f)?.type, `room ${r.file}`).toBe('object');

    const manifest = buildManifest(ctx.sha1, ctx.rom.length, result);
    const dir = join(work, 'assets');
    writeAssets(ctx.rom, manifest, dir);
    const image = readCartridge(dir);
    expect(Buffer.from(image).equals(Buffer.from(ctx.rom))).toBe(true);
    expect(sha1Hex(image)).toBe('328a1f1beba30ce5e178f031662019eb32c5f3b5');
    // The pack `npm run port` writes holds the image the individual assets rebuild, byte for byte.
    const packed = await unpackImage(await packImage(ctx.rom));
    expect(Buffer.from(packed).equals(Buffer.from(image))).toBe(true);
    const onDisk = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as typeof manifest;
    expect(onDisk.entries.length).toBe(manifest.entries.length);
  }, 600_000);
});
