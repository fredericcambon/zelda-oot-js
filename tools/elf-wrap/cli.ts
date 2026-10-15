import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadContext, romPathFromEnv } from '../analyze/context.ts';
import { wrapAll } from './wrap.ts';

function main(): number {
  const { values } = parseArgs({ options: { rom: { type: 'string' }, out: { type: 'string', default: 'out/elf' } } });
  try {
    const ctx = loadContext(romPathFromEnv(values.rom));
    const dir = values.out!;
    mkdirSync(dir, { recursive: true });
    const images = wrapAll(ctx.rom, ctx.files, ctx.layout);
    mkdirSync(join(dir, 'plain'), { recursive: true });
    for (const img of images) {
      writeFileSync(join(dir, `${img.name}.elf`), img.elf);
      writeFileSync(join(dir, 'plain', `${img.name}.elf`), img.elfPlain);
    }
    writeFileSync(join(dir, 'layout.json'), JSON.stringify(ctx.layout, null, 2) + '\n');
    console.log(`Wrote ${images.length} ELF files and layout.json to ${dir}`);
    return 0;
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

process.exitCode = main();
