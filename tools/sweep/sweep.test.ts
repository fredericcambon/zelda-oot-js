import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadContext } from '../analyze/context.ts';
import { readCartridge } from '../assets/write.ts';
import { sharedInterpreter } from '../gfx/c-dl-node.ts';
import { bootGame } from '../headless/boot.ts';
import { padAt, parseInput } from '../headless/input.ts';
import { loadBase, loadCoverage } from '../recomp/test-base.ts';
import { renderScenes, renderStatic, replaceBlock } from './render.ts';
import { mergeReports, sweepScenes, type SceneSweepReport } from './scenes.ts';
import { BOOT_HALT_UCODE, JPEG_UCODE, staticSweep } from './static.ts';

const rom = process.env.OOT_ROM;
const interpreter = await sharedInterpreter();
const work = resolve('out', 'sweep-test');
const inputPath = fileURLToPath(new URL('../headless/newgame.input', import.meta.url));

/** The coverage build made by the global setup, with the inventory it was made from. */
function buildGame() {
  return { ...loadCoverage(), inventory: loadBase().inventory };
}

describe('report blocks', () => {
  it('replaces only the text between the markers', () => {
    const doc = 'before\n<!-- a:begin -->\nold\n<!-- a:end -->\nafter\n<!-- b:begin -->\nkeep\n<!-- b:end -->';
    expect(replaceBlock(doc, 'a', 'new\n')).toBe('before\n<!-- a:begin -->\nnew\n<!-- a:end -->\nafter\n<!-- b:begin -->\nkeep\n<!-- b:end -->');
    expect(() => replaceBlock(doc, 'c', 'x')).toThrow(/no <!-- c:begin -->/);
  });

  it('merges the reports of shards', () => {
    const shard = (entrance: number, op: number): SceneSweepReport => ({
      frames: 10, startFrame: 1, sceneRecords: 2, restarts: 1, rspTasks: [{ type: 1, ucode: 5, count: op }],
      graphicsOpcodes: { '05': op }, audioOpcodes: {},
      results: [{
        entrance, scene: 0, spawn: 0, variant: 0, forced: entrance, effective: entrance, effectiveScene: 0, newFunctions: 0, outsideRdram: [], status: 'ok', reachedScene: 0, frames: 10, gfxTasks: 1, primitivesAtEnd: 1, blank: 'no',
        unknownCommands: {}, unknownSamples: {}, unknownAudio: {}, problems: [], dumps: [],
      }],
      coverage: { functions: [0x80000400 + entrance * 4], osCalls: [[1, op]], outsideRdram: [] },
    });
    const merged = mergeReports([shard(3, 2), shard(1, 5)]);
    expect(merged.results.map((r) => r.entrance)).toEqual([1, 3]);
    expect(merged.graphicsOpcodes).toEqual({ '05': 7 });
    expect(merged.rspTasks).toEqual([{ type: 1, ucode: 5, count: 7 }]);
    expect(merged.coverage?.osCalls).toEqual([[1, 7]]);
    expect(merged.coverage?.functions).toHaveLength(2);
    expect(merged.restarts).toBe(2);
  });

  it('accepts a list that ends at once', () => {
    const ram = new Uint8Array(64);
    new DataView(ram.buffer).setUint32(0, 0xdf000000);
    expect(interpreter.run(ram, 0).unknown).toEqual([]);
  });
});

describe.skipIf(!rom || !existsSync(rom))('gap sweep', () => {
  it('lists every RSP task, with the boot halt task and the type-4 task', async () => {
    const { inventory } = buildGame();
    const s = staticSweep(loadContext(rom!), inventory, resolve('runtime'), interpreter);
    const kinds = s.tasks.tasks.map((t) => `${t.type}:${t.ucode?.toString(16)}`);
    expect(kinds).toContain(`4:${BOOT_HALT_UCODE.toString(16)}`);
    expect(kinds).toContain(`4:${JPEG_UCODE.toString(16)}`);
    expect(s.tasks.tasks.some((t) => t.type === 1 && t.source === 'builder')).toBe(true);
    expect(s.tasks.tasks.some((t) => t.type === 2 && t.source === 'builder')).toBe(true);
    expect(s.tasks.tasks.every((t) => t.handled)).toBe(true);
    expect(s.tasks.submitters.find((x) => x.routine === 'osSpTaskStartGo')?.callers.length).toBeGreaterThan(0);

    expect(s.graphics.table.filter((r) => r.status === 'implemented').length).toBeGreaterThan(30);
    expect(s.graphics.table.find((r) => r.op === 0xdf)?.status).toBe('implemented');
    expect(s.audio.table).toHaveLength(24);
    expect(s.audio.table.filter((r) => r.status === 'missing').map((r) => r.op)).toEqual([0x00, 0x03, 0x04, 0x06, 0x17]);
    expect(s.os.entries.length).toBeGreaterThan(100);
    expect(s.os.entries.filter((e) => e.disposition === 'replaced').length).toBeGreaterThan(50);
    expect(s.os.mmio.length).toBeGreaterThan(0);
    expect(s.scenes.entrances).toHaveLength(1556);
    expect(s.scenes.sceneRecords).toBeGreaterThan(100);

    mkdirSync(work, { recursive: true });
    const doc = renderStatic(s);
    expect(doc).toContain('### RSP tasks');
    writeFileSync(join(work, 'static.md'), doc);
  }, 600_000);

  it('sweeps five entrances and writes the report', async () => {
    const { dist, inventory } = buildGame();
    const entrances = [0, 5, 100, 205, 465];
    const dumpDir = join(work, 'frames');
    const report = await sweepScenes({ dist, entrances, frames: 60, startFrame: 19000, input: inputPath, dumpDir, dumpsPerScene: 1, log: () => {} });
    expect(report.results.map((r) => r.entrance)).toEqual(entrances);
    for (const r of report.results) {
      expect(r.status, `entrance ${r.entrance}`).toBe('ok');
      expect(r.reachedScene, `entrance ${r.entrance}`).not.toBeNull();
      expect(r.gfxTasks).toBeGreaterThan(0);
      expect(r.dumps.length).toBe(1);
      expect(existsSync(join(dumpDir, r.dumps[0]!))).toBe(true);
    }
    expect(report.rspTasks.some((k) => k.type === 1)).toBe(true);
    expect(report.coverage?.functions.length).toBeGreaterThan(500);
    expect(report.coverage?.osCalls.length).toBeGreaterThan(10);

    const s = staticSweep(loadContext(rom!), inventory, resolve('runtime'), interpreter);
    writeFileSync(join(work, 'scenes.json'), JSON.stringify(report));
    writeFileSync(join(work, 'report.md'), `${renderStatic(s, report)}\n${renderScenes(report, s)}`);
    expect(readFileSync(join(work, 'report.md'), 'utf8')).toContain('Sweep of 5 entrances');
  }, 900_000);

  it('runs well above 3 frames per second with the display lists interpreted', async () => {
    const { moduleUrl, dist } = buildGame();
    const script = parseInput(readFileSync(inputPath, 'utf8'), 'newgame.input');
    const game = await bootGame(moduleUrl, readCartridge(join(dist, 'assets')), { onGfxTask: (task) => task.displayList() });
    const frames = 2500;
    const start = performance.now();
    for (let frame = 1; frame <= frames; frame++) {
      const pad = padAt(script, frame);
      game.setPad(pad.buttons, pad.x, pad.y);
      const r = await game.frame();
      expect(r.fatal, `frame ${frame}`).toBeUndefined();
    }
    const rate = frames / ((performance.now() - start) / 1000);
    console.log(`headless rate with display lists interpreted: ${rate.toFixed(0)} frames per second`);
    expect(rate).toBeGreaterThan(20);
  }, 600_000);
});
