// Lists the instructions that reach a low-memory word through `lui rX, 0x8000` and an offset, in every image:
// `tsx tools/headless/lowmem-scan.ts <address> [more addresses]` (hex, 0x80000300 for the TV type).
import { loadContext, romPathFromEnv } from '../analyze/context.ts';
import { buildSpecs } from '../analyze/image.ts';
import { decode, format, GPR } from '../analyze/mips.ts';

const wanted = new Set(process.argv.slice(2).map((a) => parseInt(a, 16) >>> 0));
if (wanted.size === 0) {
  console.error('usage: lowmem-scan.ts <hex address>...');
  process.exit(2);
}
const WINDOW = 24;

for (const spec of buildSpecs(loadContext(romPathFromEnv()))) {
  const dv = new DataView(spec.bytes.buffer, spec.bytes.byteOffset, spec.bytes.byteLength);
  const luiAt = new Array<number>(32).fill(-1);
  for (let o = 0; o + 4 <= spec.bytes.length; o += 4) {
    const i = decode(dv.getUint32(o), (spec.base + o) >>> 0);
    const text = spec.textEnd === null || spec.base + o < spec.textEnd;
    if (!text) break;
    if (i.op === 'lui' && i.imm === 0x8000) {
      luiAt[i.rt] = o;
      continue;
    }
    const lo = i.imm >= 0x8000 ? i.imm - 0x10000 : i.imm;
    const memory = /^(l|s)[bhwd]u?$|^[ls]wc1$/.test(i.op);
    const arith = i.op === 'ori' || i.op === 'addiu';
    if ((memory || arith) && (luiAt[i.rs] ?? -1) >= 0 && o - luiAt[i.rs]! <= WINDOW * 4 && wanted.has((0x80000000 + lo) >>> 0)) {
      console.log(`${spec.name}\t${format(i)}\t(${GPR[i.rs]} from ${(spec.base + luiAt[i.rs]!).toString(16)})`);
    }
    if (i.op === 'jr' || i.kind === 'return') luiAt.fill(-1);
    else if (!memory || /^l/.test(i.op)) {
      const dest = arith || /^l/.test(i.op) ? i.rt : i.rd;
      if (dest > 0 && i.op !== 'lui') luiAt[dest] = -1;
    }
  }
}
