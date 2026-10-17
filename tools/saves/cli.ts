// `npm run save -- <dump|verify>`: reads the save memory of the game and the sample container (docs/re/saves.md).
//   dump sram <sram.bin>      every known field of each file, with the state of both copies
//   dump sample <file>        the container, the note and what can be said about its payload
//   verify <sram.bin>         whether the game's own checks accept the image (exit 1 when it would change something)
import { readFileSync } from 'node:fs';
import { dumpSample, dumpSram } from './dump.ts';
import { verify } from './sram.ts';

function main(argv: string[]): number {
  const [cmd, a, b] = argv;
  try {
    if (cmd === 'dump' && (a === 'sram' || a === 'sample') && b) {
      const bytes = new Uint8Array(readFileSync(b));
      console.log(JSON.stringify(a === 'sram' ? dumpSram(bytes) : dumpSample(bytes), null, 2));
      return 0;
    }
    if (cmd === 'verify' && a) {
      const v = verify(new Uint8Array(readFileSync(a)));
      console.log(JSON.stringify(v, null, 2));
      return v.accepted ? 0 : 1;
    }
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  console.error('usage: save dump sram <sram.bin> | save dump sample <file> | save verify <sram.bin>');
  return 2;
}

process.exitCode = main(process.argv.slice(2));
