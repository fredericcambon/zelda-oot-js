// Mini assembler for the MIPS III integer ISA, used to write test snippets.
//
// One instruction per line, `#` starts a comment, `name:` defines a label, `.word n` emits a raw word
// `.func` starts a new function at the current address (the first function starts at `base`) and
// `.org addr` starts one at `addr`, which must lie beyond the current address.
// Branch and jump operands are labels or absolute addresses. Pseudo-instructions: `nop`, `move`, `b`, `bal`, one-operand `jalr`.
import type { FuncInput } from './emit.ts';

const REG_NAMES = [
  'zero', 'at', 'v0', 'v1', 'a0', 'a1', 'a2', 'a3', 't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7',
  's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 't8', 't9', 'k0', 'k1', 'gp', 'sp', 's8', 'ra',
];

export function parseReg(tok: string): number {
  const m = /^\$(\w+)$/.exec(tok.trim());
  if (m) {
    const name = m[1]!;
    if (/^\d+$/.test(name) && Number(name) < 32) return Number(name);
    if (name === 'fp') return 30;
    const idx = REG_NAMES.indexOf(name);
    if (idx >= 0) return idx;
  }
  throw new Error(`bad register '${tok}'`);
}

function parseNum(tok: string): number {
  const t = tok.trim();
  if (!/^-?(0x[0-9a-f]+|\d+)$/i.test(t)) throw new Error(`bad number '${tok}'`);
  return t.startsWith('-') ? -Number(t.slice(1)) : Number(t);
}

type Field = 'rs' | 'rt' | 'rd' | 'sa' | 'imm' | 'simm' | 'br' | 'jmp' | 'mem' | 'code';
interface Format {
  /** Primary opcode (bits 31..26). */
  op: number;
  /** SPECIAL function, REGIMM rt selector, or none. */
  fn?: number;
  regimm?: boolean;
  operands: Field[];
}

const R3: Field[] = ['rd', 'rs', 'rt'];
const SHIFT: Field[] = ['rd', 'rt', 'sa'];
const SHIFTV: Field[] = ['rd', 'rt', 'rs'];
const RS_RT: Field[] = ['rs', 'rt'];
const special = (fn: number, operands: Field[]): Format => ({ op: 0, fn, operands });
const itype = (op: number): Format => ({ op, operands: ['rt', 'rs', 'simm'] });
const iunsigned = (op: number): Format => ({ op, operands: ['rt', 'rs', 'imm'] });
const mem = (op: number): Format => ({ op, operands: ['rt', 'mem'] });
const regimm = (rt: number, operands: Field[]): Format => ({ op: 1, fn: rt, regimm: true, operands });

const FORMATS: Record<string, Format> = {
  sll: special(0x00, SHIFT), srl: special(0x02, SHIFT), sra: special(0x03, SHIFT),
  sllv: special(0x04, SHIFTV), srlv: special(0x06, SHIFTV), srav: special(0x07, SHIFTV),
  jr: special(0x08, ['rs']), jalr: special(0x09, ['rd', 'rs']),
  syscall: special(0x0c, ['code']), break: special(0x0d, ['code']), sync: special(0x0f, []),
  mfhi: special(0x10, ['rd']), mthi: special(0x11, ['rs']), mflo: special(0x12, ['rd']), mtlo: special(0x13, ['rs']),
  dsllv: special(0x14, SHIFTV), dsrlv: special(0x16, SHIFTV), dsrav: special(0x17, SHIFTV),
  mult: special(0x18, RS_RT), multu: special(0x19, RS_RT), div: special(0x1a, RS_RT), divu: special(0x1b, RS_RT),
  dmult: special(0x1c, RS_RT), dmultu: special(0x1d, RS_RT), ddiv: special(0x1e, RS_RT), ddivu: special(0x1f, RS_RT),
  add: special(0x20, R3), addu: special(0x21, R3), sub: special(0x22, R3), subu: special(0x23, R3),
  and: special(0x24, R3), or: special(0x25, R3), xor: special(0x26, R3), nor: special(0x27, R3),
  slt: special(0x2a, R3), sltu: special(0x2b, R3),
  dadd: special(0x2c, R3), daddu: special(0x2d, R3), dsub: special(0x2e, R3), dsubu: special(0x2f, R3),
  tge: special(0x30, RS_RT), tgeu: special(0x31, RS_RT), tlt: special(0x32, RS_RT), tltu: special(0x33, RS_RT),
  teq: special(0x34, RS_RT), tne: special(0x36, RS_RT),
  dsll: special(0x38, SHIFT), dsrl: special(0x3a, SHIFT), dsra: special(0x3b, SHIFT),
  dsll32: special(0x3c, SHIFT), dsrl32: special(0x3e, SHIFT), dsra32: special(0x3f, SHIFT),
  bltz: regimm(0x00, ['rs', 'br']), bgez: regimm(0x01, ['rs', 'br']),
  bltzl: regimm(0x02, ['rs', 'br']), bgezl: regimm(0x03, ['rs', 'br']),
  tgei: regimm(0x08, ['rs', 'simm']), tgeiu: regimm(0x09, ['rs', 'simm']),
  tlti: regimm(0x0a, ['rs', 'simm']), tltiu: regimm(0x0b, ['rs', 'simm']),
  teqi: regimm(0x0c, ['rs', 'simm']), tnei: regimm(0x0e, ['rs', 'simm']),
  bltzal: regimm(0x10, ['rs', 'br']), bgezal: regimm(0x11, ['rs', 'br']),
  bltzall: regimm(0x12, ['rs', 'br']), bgezall: regimm(0x13, ['rs', 'br']),
  j: { op: 0x02, operands: ['jmp'] }, jal: { op: 0x03, operands: ['jmp'] },
  beq: { op: 0x04, operands: ['rs', 'rt', 'br'] }, bne: { op: 0x05, operands: ['rs', 'rt', 'br'] },
  blez: { op: 0x06, operands: ['rs', 'br'] }, bgtz: { op: 0x07, operands: ['rs', 'br'] },
  beql: { op: 0x14, operands: ['rs', 'rt', 'br'] }, bnel: { op: 0x15, operands: ['rs', 'rt', 'br'] },
  blezl: { op: 0x16, operands: ['rs', 'br'] }, bgtzl: { op: 0x17, operands: ['rs', 'br'] },
  addi: itype(0x08), addiu: itype(0x09), slti: itype(0x0a), sltiu: itype(0x0b),
  andi: iunsigned(0x0c), ori: iunsigned(0x0d), xori: iunsigned(0x0e),
  lui: { op: 0x0f, operands: ['rt', 'imm'] },
  daddi: itype(0x18), daddiu: itype(0x19),
  ldl: mem(0x1a), ldr: mem(0x1b),
  lb: mem(0x20), lh: mem(0x21), lwl: mem(0x22), lw: mem(0x23), lbu: mem(0x24), lhu: mem(0x25), lwr: mem(0x26), lwu: mem(0x27),
  sb: mem(0x28), sh: mem(0x29), swl: mem(0x2a), sw: mem(0x2b), sdl: mem(0x2c), sdr: mem(0x2d), swr: mem(0x2e),
  ll: mem(0x30), lld: mem(0x34), ld: mem(0x37), sc: mem(0x38), scd: mem(0x3c), sd: mem(0x3f),
  cache: { op: 0x2f, operands: ['rt', 'mem'] },
};

export const INTEGER_MNEMONICS: readonly string[] = Object.keys(FORMATS);

interface Line {
  addr: number;
  mnemonic: string;
  args: string[];
  text: string;
}

function splitArgs(rest: string): string[] {
  return rest.trim() === '' ? [] : rest.split(',').map((s) => s.trim());
}

function expandPseudo(mnemonic: string, args: string[]): [string, string[]] {
  switch (mnemonic) {
    case 'nop': return ['sll', ['$zero', '$zero', '0']];
    case 'jalr': return args.length === 1 ? ['jalr', ['$ra', args[0]!]] : ['jalr', args];
    case 'move': return ['or', [args[0]!, args[1]!, '$zero']];
    case 'b': return ['beq', ['$zero', '$zero', args[0]!]];
    case 'bal': return ['bgezal', ['$zero', args[0]!]];
    default: return [mnemonic, args];
  }
}

export interface Assembled {
  funcs: FuncInput[];
  labels: Map<string, number>;
}

export function assemble(source: string, base: number): Assembled {
  const lines: Line[] = [];
  const labels = new Map<string, number>();
  const funcStarts = [base >>> 0];
  const funcEnds: number[] = [];
  const words = new Map<number, number>();
  let addr = base >>> 0;

  for (const raw of source.split('\n')) {
    let text = raw.replace(/#.*/, '').trim();
    for (let m = /^(\w+):\s*/.exec(text); m; m = /^(\w+):\s*/.exec(text)) {
      if (labels.has(m[1]!)) throw new Error(`duplicate label '${m[1]}'`);
      labels.set(m[1]!, addr);
      text = text.slice(m[0].length);
    }
    if (text === '') continue;
    const sp = text.search(/\s/);
    const mnemonic = sp < 0 ? text : text.slice(0, sp);
    const args = splitArgs(sp < 0 ? '' : text.slice(sp));
    if (mnemonic === '.func' || mnemonic === '.org') {
      const to = mnemonic === '.org' ? parseNum(args[0]!) >>> 0 : addr;
      if (to < addr) throw new Error(`'${text}': address lies before the current one`);
      if (addr === funcStarts[funcStarts.length - 1]) {
        funcStarts[funcStarts.length - 1] = to;
      } else {
        funcEnds.push(addr);
        funcStarts.push(to);
      }
      addr = to;
      continue;
    }
    if (mnemonic === '.word') {
      words.set(addr, parseNum(args[0]!) >>> 0);
      addr += 4;
      continue;
    }
    lines.push({ addr, mnemonic, args, text });
    addr += 4;
  }
  const end = addr;

  const target = (tok: string): number => {
    const t = tok.trim();
    if (labels.has(t)) return labels.get(t)!;
    return parseNum(t) >>> 0;
  };

  const encode = (ln: Line): number => {
    const [name, given] = expandPseudo(ln.mnemonic, ln.args);
    const fmt = FORMATS[name];
    const args = given.length === 0 && fmt?.operands[0] === 'code' ? ['0'] : given;
    if (!fmt) throw new Error(`unknown instruction '${ln.mnemonic}' in '${ln.text}'`);
    if (args.length !== fmt.operands.length) throw new Error(`'${ln.text}': expected ${fmt.operands.length} operands`);
    let rs = 0, rt = 0, rd = 0, sa = 0, low = 0, code = 0;
    fmt.operands.forEach((field, k) => {
      const a = args[k]!;
      switch (field) {
        case 'rs': rs = parseReg(a); break;
        case 'rt': rt = parseReg(a); break;
        case 'rd': rd = parseReg(a); break;
        case 'sa': sa = parseNum(a); if (sa < 0 || sa > 31) throw new Error(`'${ln.text}': bad shift amount`); break;
        case 'imm': low = parseNum(a); if (low < 0 || low > 0xffff) throw new Error(`'${ln.text}': immediate out of range`); break;
        case 'simm': low = parseNum(a); if (low < -0x8000 || low > 0x7fff) throw new Error(`'${ln.text}': immediate out of range`); break;
        case 'br': {
          const off = (target(a) - (ln.addr + 4)) / 4;
          if (!Number.isInteger(off) || off < -0x8000 || off > 0x7fff) throw new Error(`'${ln.text}': branch out of range`);
          low = off;
         
          break;
        }
        case 'jmp': {
          const t = target(a);
          if ((t & 3) !== 0 || (t & 0xf0000000) !== ((ln.addr + 4) & 0xf0000000)) throw new Error(`'${ln.text}': bad jump target`);
          low = (t & 0x0fffffff) >>> 2;
          break;
        }
        case 'mem': {
          const m = /^(-?\w+)?\(\s*(\$\w+)\s*\)$/.exec(a);
          if (!m) throw new Error(`'${ln.text}': bad memory operand`);
          low = m[1] ? parseNum(m[1]) : 0;
          if (low < -0x8000 || low > 0x7fff) throw new Error(`'${ln.text}': offset out of range`);
          rs = parseReg(m[2]!);
         
          break;
        }
        case 'code': code = parseNum(a); break;
      }
    });
    if (fmt.op === 0) {
      return ((rs << 21) | (rt << 16) | (rd << 11) | (sa << 6) | (code << 6) | fmt.fn!) >>> 0;
    }
    if (fmt.regimm) return ((1 << 26) | (rs << 21) | (fmt.fn! << 16) | (low & 0xffff)) >>> 0;
    if (fmt.op === 2 || fmt.op === 3) return ((fmt.op << 26) | low) >>> 0;
    return ((fmt.op << 26) | (rs << 21) | (rt << 16) | (low & 0xffff)) >>> 0;
  };

  for (const ln of lines) words.set(ln.addr, encode(ln));

  funcEnds.push(end);
  const funcs: FuncInput[] = funcStarts.map((start, f) => {
    const out: number[] = [];
    for (let a = start; a < funcEnds[f]!; a += 4) out.push(words.get(a)!);
    return { addr: start, words: out };
  });
  return { funcs, labels };
}
