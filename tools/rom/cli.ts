import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { extractRom } from './extract.ts';

function main(): number {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { rom: { type: 'string' }, out: { type: 'string', default: 'out' } },
  });
  if (positionals[0] !== 'extract') {
    console.error('usage: rom extract [--rom <path>] [--out <dir>]   (ROM path defaults to $OOT_ROM)');
    return 2;
  }
  const romPath = values.rom ?? process.env.OOT_ROM;
  if (!romPath) {
    console.error('no ROM given: set OOT_ROM or pass --rom <path>');
    return 2;
  }
  try {
    const index = extractRom(readFileSync(romPath), values.out!);
    const packed = index.files.filter((f) => f.compressed).length;
    console.log(`ROM verified (SHA-1 ${index.sha1}).`);
    console.log(`Wrote ${index.files.length} files (${packed} were compressed) and ${values.out}/index.json.`);
    return 0;
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

process.exitCode = main();
