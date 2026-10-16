// Prints the audio microcode the game ships in its code file: `tsx tools/audio/microcode.ts` lists the text, one
// instruction per line with its offset in the instruction memory; `tsx tools/audio/microcode.ts data` dumps the data
// segment as hex. Addresses are the ones the audio task builder passes (docs/re/audio.md).
import { loadContext, romPathFromEnv } from '../analyze/context.ts';
import { buildSpecs } from '../analyze/image.ts';
import { disassembleRspRange } from './rspdis.ts';

const TEXT = { address: 0x800e0f10, size: 0x1000 };
const DATA = { address: 0x801120e0, size: 0x2e0 };

const code = buildSpecs(loadContext(romPathFromEnv())).find((s) => s.name === 'code');
if (!code) throw new Error('the ROM has no code file');
const slice = (r: { address: number; size: number }) => code.bytes.subarray(r.address - code.base, r.address - code.base + r.size);

if (process.argv[2] === 'data') {
  const hex = Buffer.from(slice(DATA)).toString('hex');
  for (let i = 0; i < hex.length; i += 64) console.log(`${(i / 2).toString(16).padStart(4, '0')}: ${hex.slice(i, i + 64)}`);
} else {
  for (const line of disassembleRspRange(slice(TEXT), 0)) console.log(line);
}
