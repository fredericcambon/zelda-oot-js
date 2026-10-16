// Disassembles RSP microcode held in an image: `tsx tools/analyze/rsp.ts <image> <start> <size>` (hex addresses and size).
// Addresses printed are offsets in the RSP instruction memory (the microcode starts at 0). The scalar part is the MIPS
// subset the RSP implements; the vector part follows the instruction encodings of the RSP vector unit as documented on
// n64brew.dev (COP2 computational ops, LWC2/SWC2 vector loads and stores).

import { loadContext, romPathFromEnv } from './context.ts';
import { buildSpecs } from './image.ts';

const REGS = ['zr', 'at', 'v0', 'v1', 'a0', 'a1', 'a2', 'a3', 't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 't8', 't9', 'k0', 'k1', 'gp', 'sp', 'fp', 'ra'];
const VECTOR_OPS: Record<number, string> = {
  0: 'vmulf', 1: 'vmulu', 2: 'vrndp', 3: 'vmulq', 4: 'vmudl', 5: 'vmudm', 6: 'vmudn', 7: 'vmudh', 8: 'vmacf', 9: 'vmacu', 10: 'vrndn', 11: 'vmacq',
  12: 'vmadl', 13: 'vmadm', 14: 'vmadn', 15: 'vmadh', 16: 'vadd', 17: 'vsub', 19: 'vabs', 20: 'vaddc', 21: 'vsubc', 29: 'vsar', 32: 'vlt', 33: 'veq',
  34: 'vne', 35: 'vge', 36: 'vcl', 37: 'vch', 38: 'vcr', 39: 'vmrg', 40: 'vand', 41: 'vnand', 42: 'vor', 43: 'vnor', 44: 'vxor', 45: 'vnxor',
  48: 'vrcp', 49: 'vrcpl', 50: 'vrcph', 51: 'vmov', 52: 'vrsq', 53: 'vrsql', 54: 'vrsqh', 55: 'vnop',
};
const VECTOR_LOADS = ['lbv', 'lsv', 'llv', 'ldv', 'lqv', 'lrv', 'lpv', 'luv', 'lhv', 'lfv', 'lwv', 'ltv'];
const VECTOR_STORES = ['sbv', 'ssv', 'slv', 'sdv', 'sqv', 'srv', 'spv', 'suv', 'shv', 'sfv', 'swv', 'stv'];
const SPECIAL: Record<number, string> = {
  0: 'sll', 2: 'srl', 3: 'sra', 4: 'sllv', 6: 'srlv', 7: 'srav', 8: 'jr', 9: 'jalr', 13: 'break', 32: 'add', 33: 'addu', 34: 'sub', 35: 'subu',
  36: 'and', 37: 'or', 38: 'xor', 39: 'nor', 42: 'slt', 43: 'sltu',
};

export function disassembleRsp(code: Uint8Array): string[] {
  const dv = new DataView(code.buffer, code.byteOffset, code.length);
  const out: string[] = [];
  for (let pc = 0; pc + 4 <= code.length; pc += 4) {
    const w = dv.getUint32(pc);
    const op = w >>> 26, rs = (w >>> 21) & 31, rt = (w >>> 16) & 31, rd = (w >>> 11) & 31, sa = (w >>> 6) & 31, fn = w & 63;
    const imm = w & 0xffff, simm = (imm << 16) >> 16;
    const target = ((pc + 4 + simm * 4) & 0xfff).toString(16);
    const element = (w >>> 21) & 15;
    let text: string;
    if (op === 0) {
      const name = SPECIAL[fn] ?? `special${fn}`;
      text = fn < 4 ? `${name} ${REGS[rd]}, ${REGS[rt]}, ${sa}` : fn < 8 ? `${name} ${REGS[rd]}, ${REGS[rt]}, ${REGS[rs]}`
        : fn === 8 ? `jr ${REGS[rs]}` : fn === 9 ? `jalr ${REGS[rd]}, ${REGS[rs]}` : fn === 13 ? 'break' : `${name} ${REGS[rd]}, ${REGS[rs]}, ${REGS[rt]}`;
    } else if (op === 1) text = `${['bltz', 'bgez', 'bltzal', 'bgezal'][rt & 3]} ${REGS[rs]}, ${target}`;
    else if (op === 2 || op === 3) text = `${op === 2 ? 'j' : 'jal'} ${(((w & 0x3ffffff) << 2) & 0xfff).toString(16)}`;
    else if (op >= 4 && op <= 7) text = `${['beq', 'bne', 'blez', 'bgtz'][op - 4]} ${REGS[rs]}, ${REGS[rt]}, ${target}`;
    else if (op >= 8 && op <= 15) text = `${['addi', 'addiu', 'slti', 'sltiu', 'andi', 'ori', 'xori', 'lui'][op - 8]} ${REGS[rt]}, ${REGS[rs]}, ${op >= 12 ? `0x${imm.toString(16)}` : simm}`;
    else if (op === 16) text = `${rs === 0 ? 'mfc0' : 'mtc0'} ${REGS[rt]}, c0_${rd}`;
    else if (op === 18) {
      text = w & 0x2000000 ? `${VECTOR_OPS[fn] ?? `vop${fn}`} v${sa}, v${rd}, v${rt}[${element}]`
        : `${({ 0: 'mfc2', 2: 'cfc2', 4: 'mtc2', 6: 'ctc2' } as Record<number, string>)[rs] ?? 'cop2'} ${REGS[rt]}, v${rd}[${(w >>> 7) & 15}]`;
    } else if (op >= 32 && op <= 39) text = `${['lb', 'lh', 'lwl', 'lw', 'lbu', 'lhu', 'lwr', 'lwu'][op - 32]} ${REGS[rt]}, ${simm}(${REGS[rs]})`;
    else if (op >= 40 && op <= 43) text = `${['sb', 'sh', 'swl', 'sw'][op - 40]} ${REGS[rt]}, ${simm}(${REGS[rs]})`;
    else if (op === 50 || op === 58) {
      const kind = (w >>> 11) & 31;
      text = `${(op === 50 ? VECTOR_LOADS : VECTOR_STORES)[kind] ?? `vmem${kind}`} v${rt}[${(w >>> 7) & 15}], ${((w & 0x7f) << 25) >> 25}(${REGS[rs]})`;
    } else text = `op${op}`;
    out.push(`${pc.toString(16).padStart(3, '0')}: ${w.toString(16).padStart(8, '0')}  ${text}`);
  }
  return out;
}

if (process.argv[1]?.endsWith('rsp.ts')) {
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
  for (const line of disassembleRsp(spec.bytes.subarray(start, start + parseInt(sizeArg, 16)))) console.log(line);
}
