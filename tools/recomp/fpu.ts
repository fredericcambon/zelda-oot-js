// COP1 (FPU) instructions to C over the helpers of runtime/cpu.h.
import type { Insn } from '../analyze/mips.ts';

type Fmt = 's' | 'd' | 'w' | 'l';

const read = (fmt: Fmt, n: number) =>
  fmt === 's' ? `fpr_s(c, ${n})` : fmt === 'd' ? `fpr_dbl(c, ${n})` : fmt === 'w' ? `(int32_t)fpr_w(c, ${n})` : `(int64_t)fpr_d(c, ${n})`;
const write = (fmt: Fmt, n: number, expr: string) =>
  fmt === 's' ? `set_fpr_s(c, ${n}, ${expr});` : fmt === 'd' ? `set_fpr_dbl(c, ${n}, ${expr});` : fmt === 'w' ? `set_fpr_w(c, ${n}, (uint32_t)(${expr}));` : `set_fpr_d(c, ${n}, (uint64_t)(${expr}));`;

/** Sign bit of the raw encoding, so that abs, neg and mov leave NaN payloads alone. */
const SIGN = { s: '0x80000000u', d: '0x8000000000000000ull' } as const;

function arith(op: string, fmt: 's' | 'd', fd: number, fs: number, ft: number): string | undefined {
  const sym: Record<string, string> = { add: '+', sub: '-', mul: '*', div: '/' };
  if (sym[op]) return write(fmt, fd, `${read(fmt, fs)} ${sym[op]} ${read(fmt, ft)}`);
  const raw = fmt === 's' ? (n: number) => `fpr_w(c, ${n})` : (n: number) => `fpr_d(c, ${n})`;
  const put = fmt === 's' ? (e: string) => `set_fpr_w(c, ${fd}, ${e});` : (e: string) => `set_fpr_d(c, ${fd}, ${e});`;
  switch (op) {
    case 'sqrt': return write(fmt, fd, `${fmt === 's' ? 'sqrtf' : 'sqrt'}(${read(fmt, fs)})`);
    case 'abs': return put(`${raw(fs)} & ~${SIGN[fmt]}`);
    case 'neg': return put(`${raw(fs)} ^ ${SIGN[fmt]}`);
    case 'mov': return put(raw(fs));
  }
  return undefined;
}

const ROUND: Record<string, string> = { round: '0', trunc: '1', ceil: '2', floor: '3' };

function convert(op: string, dest: Fmt, src: Fmt, fd: number, fs: number): string | undefined {
  if (src === 'w' || src === 'l') {
    if (op !== 'cvt' || dest === src || (dest !== 's' && dest !== 'd')) return undefined;
    return write(dest, fd, `(${dest === 's' ? 'float' : 'double'})${read(src, fs)}`);
  }
  const x = src === 's' ? `(double)${read(src, fs)}` : read(src, fs);
  if (op === 'cvt') {
    if (dest === 's') return src === 'd' ? write('s', fd, `(float)${read('d', fs)}`) : undefined;
    if (dest === 'd') return src === 's' ? write('d', fd, `(double)${read('s', fs)}`) : undefined;
    const mode = 'FP_MODE(c)';
    return dest === 'w' ? write('w', fd, `fp_to_w(${x}, ${mode})`) : write('l', fd, `fp_to_l(${x}, ${mode})`);
  }
  const mode = ROUND[op];
  if (mode === undefined) return undefined;
  return dest === 'w' ? write('w', fd, `fp_to_w(${x}, ${mode})`) : write('l', fd, `fp_to_l(${x}, ${mode})`);
}

/** C for a COP1 instruction that is not a branch, or undefined when it is not one. */
export function fpuPlain(i: Insn, addr: (i: Insn) => string, setGpr: (n: number, expr: string) => string, gpr: (n: number) => string): string | undefined {
  const fs = i.rd;
  const ft = i.rt;
  const fd = (i.word >>> 6) & 31;
  const U32 = (n: number) => `(uint32_t)${gpr(n)}`;
  switch (i.op) {
    case 'lwc1': return `set_fpr_w(c, ${ft}, rd32(${addr(i)}));`;
    case 'swc1': return `wr32(${addr(i)}, fpr_w(c, ${ft}));`;
    case 'ldc1': return `set_fpr_d(c, ${ft}, rd64(${addr(i)}));`;
    case 'sdc1': return `wr64(${addr(i)}, fpr_d(c, ${ft}));`;
    case 'mfc1': return setGpr(ft, `SX32(fpr_w(c, ${fs}))`);
    case 'dmfc1': return setGpr(ft, `fpr_d(c, ${fs})`);
    case 'mtc1': return `set_fpr_w(c, ${fs}, ${U32(ft)});`;
    case 'dmtc1': return `set_fpr_d(c, ${fs}, ${gpr(ft)});`;
    case 'cfc1': return setGpr(ft, `cfc1(c, ${fs})`);
    case 'ctc1': return `ctc1(c, ${fs}, ${U32(ft)});`;
  }
  const m = /^(c\.(\w+)|(\w+(?:\.\w)?))\.([sdwl])$/.exec(i.op);
  if (!m) return undefined;
  const fmt = m[4] as Fmt;
  if (m[2] !== undefined) {
    if (fmt !== 's' && fmt !== 'd') return undefined;
    const cond = ['f', 'un', 'eq', 'ueq', 'olt', 'ult', 'ole', 'ule', 'sf', 'ngle', 'seq', 'ngl', 'lt', 'nge', 'le', 'ngt'].indexOf(m[2]);
    const a = read(fmt, fs);
    const b = read(fmt, ft);
    return `{ ${fmt === 's' ? 'float' : 'double'} a = ${a}, b = ${b}; fp_cmp(c, ${cond}, a != a || b != b, a < b, a == b); }`;
  }
  const [op, dest] = m[3]!.split('.') as [string, Fmt | undefined];
  if (dest === undefined) return fmt === 's' || fmt === 'd' ? arith(op, fmt, fd, fs, ft) : undefined;
  return convert(op, dest, fmt, fd, fs);
}

/** Branch condition of bc1t, bc1f and their likely forms. */
export const FPU_CONDITIONS: Record<string, string> = { bc1t: 'FP_COND(c)', bc1f: '!FP_COND(c)' };
