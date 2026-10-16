// Disassembles RSP microcode held in an image: `tsx tools/analyze/rsp.ts <image> <start> <size>` (hex addresses and size).
// Addresses printed are offsets in the RSP instruction memory (the microcode starts at 0).
import { disassembleRspRange } from '../audio/rspdis.ts';
import { loadContext, romPathFromEnv } from './context.ts';
import { buildSpecs } from './image.ts';

const [name, startArg, sizeArg] = process.argv.slice(2);
if (!name || !startArg || !sizeArg) {
  console.error('usage: rsp.ts <image> <start> <size>   (hex)');
  process.exit(2);
}
const spec = buildSpecs(loadContext(romPathFromEnv())).find((s) => s.name === name);
if (!spec) {
  console.error(`unknown image ${name}`);
  process.exit(2);
}
const start = parseInt(startArg, 16) - spec.base;
for (const line of disassembleRspRange(spec.bytes.subarray(start, start + parseInt(sizeArg, 16)), 0)) console.log(line);
