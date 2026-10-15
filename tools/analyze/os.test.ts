import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadContext } from './context.ts';
import { analyseImage, buildSpecs } from './image.ts';
import { identifyOs, loadSignatures, type OsRoutine } from './os.ts';
import { renderRoutines, spliceDoc } from './os-doc.ts';

const rom = process.env.OOT_ROM;

/** The routines the runtime replaces, grouped by what they do. Each is either found at one address or declared absent. */
const REQUIRED: Record<string, { found: string[]; absent?: string[] }> = {
  threads: { found: ['osCreateThread', 'osStartThread', 'osStopThread', 'osDestroyThread', 'osYieldThread', 'osSetThreadPri', 'osGetThreadId'] },
  messageQueues: { found: ['osCreateMesgQueue', 'osSendMesg', 'osRecvMesg', 'osJamMesg'] },
  events: { found: ['osSetEventMesg', 'os_internal_exception_send_event', 'os_internal_set_hw_intr_routine'] },
  pi: { found: ['osEPiStartDma', 'osPiGetCmdQueue', 'osEPiReadIo', 'osEPiWriteIo', 'osCreatePiManager', 'os_internal_dev_mgr_main'] },
  vi: {
    found: ['osViSetMode', 'osViSwapBuffer', 'osViBlack', 'osViSetEvent', 'osCreateViManager', 'os_internal_vi_mgr_main', 'os_internal_vi_swap_context'],
  },
  timers: { found: ['osGetCount', 'osGetTime', 'osSetTimer', 'osStopTimer', 'os_internal_timer_interrupt'] },
  controllers: { found: ['osContInit', 'osContStartReadData', 'osContGetReadData', 'osContStartQuery', 'osContGetQuery'] },
  saves: {
    found: ['sram_transfer', 'sram_pi_transfer'],
    absent: [
      'osEepromProbe', 'osEepromRead', 'osEepromWrite', 'osEepromLongRead', 'osEepromLongWrite',
      'osFlashInit', 'osFlashReadId', 'osFlashReadStatus', 'osFlashClearStatus', 'osFlashAllErase', 'osFlashSectorErase',
      'osFlashWriteBuffer', 'osFlashWriteArray', 'osFlashReadArray',
    ],
  },
  rsp: { found: ['osSpTaskLoad', 'osSpTaskStartGo', 'osSpTaskYield', 'osSpTaskYielded'] },
  cacheAndTlb: {
    found: ['osWritebackDCache', 'osWritebackDCacheAll', 'osInvalDCache', 'osInvalICache', 'os_internal_probe_tlb', 'osUnmapTLBAll'],
    absent: ['osMapTLB', 'osUnmapTLB', 'osSetTLBASID'],
  },
  interruptsAndExceptions: { found: ['os_internal_exception_vector', 'os_internal_exception', 'os_internal_disable_int', 'os_internal_restore_int', 'osSetIntMask'] },
  overlays: { found: ['overlay_load', 'overlay_relocate'] },
};

describe('reverse-engineering notes', () => {
  for (const name of ['os-routines', 'boot-flow', 'overlays', 'analysis-tool', 'rea-howto']) {
    it(`docs/re/${name}.md exists and cites addresses`, () => {
      const text = readFileSync(`docs/re/${name}.md`, 'utf8');
      expect(text).toMatch(/0x[0-9A-Fa-f]{8}/);
    });
  }
});

describe.skipIf(!rom || !existsSync(rom))('OS routines of the ROM', () => {
  const sigs = loadSignatures();
  const ctx = loadContext(rom!);
  const specs = buildSpecs(ctx);
  const result = identifyOs(ctx, specs, specs.map((s) => analyseImage(s)), sigs);
  const byId = new Map<string, OsRoutine>(result.routines.map((r) => [r.id, r]));

  it('resolves every rule to exactly one address', () => {
    const unresolved = result.routines.filter((r) => r.status !== 'found' && r.status !== 'not-present');
    expect(unresolved.map((r) => `${r.id}: ${r.status}`)).toEqual([]);
  });

  it('gives each routine its own address', () => {
    const seen = new Map<string, string>();
    for (const r of result.routines.filter((x) => x.status === 'found')) {
      const key = `${r.image}:${r.addr}`;
      expect(seen.get(key), `${r.id} shares ${key}`).toBeUndefined();
      seen.set(key, r.id);
    }
  });

  it('cites the routine address first in every rule evidence', () => {
    for (const rule of sigs.rules) {
      const m = /^0x([0-9a-f]{8})/.exec(rule.evidence);
      if (m) expect(parseInt(m[1]!, 16), rule.id).toBe(byId.get(rule.id)!.addr);
    }
  });

  for (const [group, want] of Object.entries(REQUIRED)) {
    it(`identifies the ${group} routines or marks them not present`, () => {
      for (const id of want.found) expect(byId.get(id)?.status, id).toBe('found');
      for (const id of want.absent ?? []) {
        const r = byId.get(id);
        expect(r?.status, id).toBe('not-present');
        expect(r!.evidence.length, id).toBeGreaterThan(40);
      }
    });
  }

  it('keeps the generated reference of os-routines.md current', () => {
    const doc = readFileSync('docs/re/os-routines.md', 'utf8');
    expect(spliceDoc(doc, renderRoutines(result.routines))).toBe(doc);
  });

  it('finds the boot routines at their documented addresses', () => {
    expect(byId.get('boot_entry')?.addr).toBe(0x80000400);
    expect(byId.get('boot_main')?.addr).toBe(0x80000498);
    expect(byId.get('code_entry')?.addr).toBe(0x800a2390);
  });
});
