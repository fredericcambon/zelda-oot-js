import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseElf } from '../elf-wrap/elf.ts';
import { COVERAGE_TARGET, renderCoverage, shortfalls } from './coverage.ts';
import type { Inventory } from './types.ts';

const inventoryPath = 'out/inventory.json';
const romGated = !process.env.OOT_ROM || !existsSync(inventoryPath);

describe.skipIf(romGated)('inventory of the ROM', () => {
  const inv = (): Inventory => JSON.parse(readFileSync(inventoryPath, 'utf8')) as Inventory;

  it('covers the boot code, the code file and every overlay', () => {
    const images = inv().images;
    expect(images.filter((i) => i.kind === 'boot')).toHaveLength(1);
    expect(images.filter((i) => i.kind === 'code')).toHaveLength(1);
    expect(images.filter((i) => i.kind === 'overlay').length).toBeGreaterThanOrEqual(469);
  });

  it('wraps every image as an ELF that parses', () => {
    for (const im of inv().images) {
      for (const dir of ['out/elf', 'out/elf/plain']) {
        const e = parseElf(new Uint8Array(readFileSync(`${dir}/${im.name}.elf`)));
        expect(e.sections.some((s) => s.name === '.text'), `${dir}/${im.name}`).toBe(true);
      }
    }
  });

  it('never overlaps function ranges', () => {
    for (const im of inv().images) {
      const fns = [...im.functions].sort((a, b) => a.start - b.start);
      for (let i = 0; i < fns.length; i++) {
        expect(fns[i]!.end, `${im.name} ${fns[i]!.start.toString(16)}`).toBeGreaterThan(fns[i]!.start);
        if (i > 0) expect(fns[i]!.start, `${im.name} ${fns[i]!.start.toString(16)}`).toBeGreaterThanOrEqual(fns[i - 1]!.end);
      }
    }
  });

  it('reaches the coverage target in every section', () => {
    expect(shortfalls(inv())).toEqual([]);
    expect(renderCoverage(inv())).toContain(`reach ${COVERAGE_TARGET}%`);
  });
});
