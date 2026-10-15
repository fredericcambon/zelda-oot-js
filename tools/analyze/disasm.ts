// Prints the disassembly of an address range of one image: `tsx tools/analyze/disasm.ts <image> <start> [end]`.
// Without `end`, the function of the inventory (out/inventory.json) that contains `start` is printed.

import { existsSync, readFileSync } from 'node:fs';
import { loadContext, romPathFromEnv } from './context.ts';
import { buildSpecs } from './image.ts';
import { disassemble, format } from './mips.ts';
import type { Inventory } from './types.ts';

const [name, startArg, endArg] = process.argv.slice(2);
if (!name || !startArg) {
  console.error('usage: disasm.ts <image> <start> [end]   (addresses in hex)');
  process.exit(2);
}
const spec = buildSpecs(loadContext(romPathFromEnv())).find((s) => s.name === name);
if (!spec) {
  console.error(`unknown image ${name}`);
  process.exit(2);
}
const start = parseInt(startArg, 16) >>> 0;
let end = endArg ? parseInt(endArg, 16) >>> 0 : start + 4;
if (!endArg && existsSync('out/inventory.json')) {
  const inv = JSON.parse(readFileSync('out/inventory.json', 'utf8')) as Inventory;
  const fn = inv.images.find((i) => i.name === name)?.functions.find((f) => f.start <= start && start < f.end);
  if (fn) end = fn.end;
}
for (const i of disassemble(spec.bytes, spec.base, start - spec.base, end - spec.base)) console.log(format(i));
