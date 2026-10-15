import { DATA_BASE as D, dwords, words } from './harness.ts';
import type { Snippet } from './harness.ts';
import { full, snip, snippetSuite } from './suite.ts';

const buf = new DataView(new ArrayBuffer(8));
/** Raw bits of a single-precision value. */
const s = (x: number): bigint => (buf.setFloat32(0, x), BigInt(buf.getUint32(0)));
/** Raw bits of a double-precision value. */
const d = (x: number): bigint => (buf.setFloat64(0, x), buf.getBigUint64(0));
const w = (x: number): number => (buf.setFloat32(0, x), buf.getUint32(0));
const SX = (x: bigint) => BigInt.asIntN(32, x) & 0xffffffffffffffffn;

const COND = 0x00800000;
const ONES = 0xffffffffffffffffn;

/** Single-instruction arithmetic on f2 and f4 with the result in f0. */
function arith(name: string, asm: string, f2: bigint, f4: bigint, want: bigint, extra: Partial<Snippet> = {}): Snippet {
  return snip(name, asm, {}, {}, { fregs: { f2, f4 }, expectF: { f0: want, f2, f4 }, ...extra });
}

const arithmetic: Snippet[] = [
  arith('add.s', 'add.s $f0, $f2, $f4', s(1.5), s(2.25), s(3.75)),
  arith('sub.s', 'sub.s $f0, $f2, $f4', s(1.5), s(2.25), s(-0.75)),
  arith('mul.s', 'mul.s $f0, $f2, $f4', s(1.5), s(-4), s(-6)),
  arith('div.s', 'div.s $f0, $f2, $f4', s(1), s(4), s(0.25)),
  arith('div.s by zero is infinity', 'div.s $f0, $f2, $f4', s(1), s(0), s(Infinity)),
  arith('sqrt.s', 'sqrt.s $f0, $f2', s(2.25), 0n, s(1.5)),
  arith('add.d', 'add.d $f0, $f2, $f4', d(1e100), d(2.5e100), d(3.5e100)),
  arith('sub.d', 'sub.d $f0, $f2, $f4', d(1), d(0.1), d(0.9)),
  arith('mul.d', 'mul.d $f0, $f2, $f4', d(1.5), d(1.5), d(2.25)),
  arith('div.d', 'div.d $f0, $f2, $f4', d(10), d(4), d(2.5)),
  arith('sqrt.d', 'sqrt.d $f0, $f2', d(2), 0n, d(Math.SQRT2)),
  arith('single precision rounds to single', 'add.s $f0, $f2, $f4', s(16777216), s(1), s(16777216)),
  arith('abs.s', 'abs.s $f0, $f2', s(-3), 0n, s(3)),
  arith('abs.s keeps a NaN payload', 'abs.s $f0, $f2', 0xffc12345n, 0n, 0x7fc12345n),
  arith('neg.s', 'neg.s $f0, $f2', s(3), 0n, s(-3)),
  arith('neg.s of zero', 'neg.s $f0, $f2', s(0), 0n, 0x80000000n),
  arith('abs.d', 'abs.d $f0, $f2', d(-0.5), 0n, d(0.5)),
  arith('neg.d', 'neg.d $f0, $f2', d(0.5), 0n, d(-0.5)),
  arith('mov.s copies the low word only', 'mov.s $f0, $f2', 0x1111111122222222n, 0n, 0x22222222n),
  arith('mov.d', 'mov.d $f0, $f2', 0x1111111122222222n, 0n, 0x1111111122222222n),
];

/** Conversion of f2 into f0 with a rounding mode in FCSR. */
function cvt(name: string, asm: string, f2: bigint, want: bigint, rm = 0): Snippet {
  return snip(name, asm, {}, {}, { fregs: { f2 }, fcsr: rm, expectF: { f0: want, f2 }, expectFcsr: rm });
}

const conversions: Snippet[] = [
  cvt('cvt.d.s', 'cvt.d.s $f0, $f2', s(1.5), d(1.5)),
  cvt('cvt.s.d', 'cvt.s.d $f0, $f2', d(0.1), s(0.1)),
  cvt('cvt.s.w', 'cvt.s.w $f0, $f2', 0xfffffffdn, s(-3)),
  cvt('cvt.d.w', 'cvt.d.w $f0, $f2', 0x7fffffffn, d(2147483647)),
  cvt('cvt.s.l', 'cvt.s.l $f0, $f2', 0xfffffffffffffff0n, s(-16)),
  cvt('cvt.d.l', 'cvt.d.l $f0, $f2', 1n << 40n, d(2 ** 40)),
  cvt('cvt.w.s rounds to nearest even', 'cvt.w.s $f0, $f2', s(2.5), 2n),
  cvt('cvt.w.s nearest, 3.5', 'cvt.w.s $f0, $f2', s(3.5), 4n),
  cvt('cvt.w.s toward zero', 'cvt.w.s $f0, $f2', s(-2.7), 0xfffffffen, 1),
  cvt('cvt.w.s toward plus infinity', 'cvt.w.s $f0, $f2', s(2.1), 3n, 2),
  cvt('cvt.w.s toward minus infinity', 'cvt.w.s $f0, $f2', s(-2.1), 0xfffffffdn, 3),
  cvt('cvt.w.d nearest', 'cvt.w.d $f0, $f2', d(-2.5), 0xfffffffen),
  cvt('cvt.l.d nearest', 'cvt.l.d $f0, $f2', d(1e15 + 0.5), 1000000000000000n),
  cvt('cvt.l.s toward zero', 'cvt.l.s $f0, $f2', s(-7.9), ONES - 6n, 1),
  cvt('round.w.s', 'round.w.s $f0, $f2', s(2.5), 2n, 1),
  cvt('trunc.w.s', 'trunc.w.s $f0, $f2', s(-2.7), 0xfffffffen),
  cvt('ceil.w.s', 'ceil.w.s $f0, $f2', s(2.1), 3n),
  cvt('floor.w.s', 'floor.w.s $f0, $f2', s(-2.1), 0xfffffffdn),
  cvt('round.w.d', 'round.w.d $f0, $f2', d(3.5), 4n, 1),
  cvt('trunc.w.d', 'trunc.w.d $f0, $f2', d(3.9), 3n, 2),
  cvt('ceil.w.d', 'ceil.w.d $f0, $f2', d(-3.9), 0xfffffffdn),
  cvt('floor.w.d', 'floor.w.d $f0, $f2', d(3.9), 3n),
  cvt('round.l.d', 'round.l.d $f0, $f2', d(-0.5), 0n, 1),
  cvt('trunc.l.d', 'trunc.l.d $f0, $f2', d(-4294967296.5), ONES - 4294967295n),
  cvt('ceil.l.s', 'ceil.l.s $f0, $f2', s(0.25), 1n),
  cvt('floor.l.s', 'floor.l.s $f0, $f2', s(-0.25), ONES),
  cvt('too large for a word saturates', 'cvt.w.s $f0, $f2', s(3e9), 0x7fffffffn),
  cvt('too small for a word saturates', 'trunc.w.s $f0, $f2', s(-3e9), 0x80000000n),
  cvt('NaN converts to the largest word', 'trunc.w.d $f0, $f2', 0x7ff8000000000000n, 0x7fffffffn),
  cvt('too large for a long saturates', 'trunc.l.d $f0, $f2', d(1e30), 0x7fffffffffffffffn),
];

const moves: Snippet[] = [
  snip('lwc1 and swc1', 'lwc1 $f2, 0($t1)\nswc1 $f2, 8($t1)', { t1: D }, {}, {
    mem: [words(D, w(1.5))], fregs: { f2: 0xaaaaaaaa00000000n }, expectF: { f2: 0xaaaaaaaa00000000n | BigInt(w(1.5)) },
    expectMem: [words(D + 8, w(1.5))],
  }),
  snip('ldc1 and sdc1', 'ldc1 $f4, 0($t1)\nsdc1 $f4, 16($t1)', { t1: D }, {}, {
    mem: [dwords(D, d(-2.5))], expectF: { f4: d(-2.5) }, expectMem: [dwords(D + 16, d(-2.5))],
  }),
  snip('mtc1 keeps the upper word', 'mtc1 $t0, $f4', { t0: 0xffffffff80000001n }, {}, {
    fregs: { f4: 0x1234567800000000n }, expectF: { f4: 0x1234567880000001n },
  }),
  snip('mfc1 sign extends', 'mfc1 $t0, $f4', {}, { t0: 0xffffffff80000001n }, { fregs: { f4: 0x1234567880000001n }, expectF: { f4: 0x1234567880000001n } }),
  snip('dmtc1', 'dmtc1 $t0, $f4', { t0: 0x0123456789abcdefn }, {}, { expectF: { f4: 0x0123456789abcdefn } }),
  snip('dmfc1', 'dmfc1 $t0, $f4', {}, { t0: 0x0123456789abcdefn }, { fregs: { f4: 0x0123456789abcdefn }, expectF: { f4: 0x0123456789abcdefn } }),
  snip('ctc1 keeps the defined FCSR bits', 'ctc1 $t0, $31', { t0: 0xffffffffffffffffn }, {}, { expectFcsr: 0x0183ffff }),
  snip('cfc1 reads FCSR', 'cfc1 $t0, $31', {}, { t0: SX(0x01800003n) }, { fcsr: 0x01800003, expectFcsr: 0x01800003 }),
  snip('cfc1 reads the revision register', 'cfc1 $t0, $0', {}, { t0: 0n }),
];

/** FR = 0: odd registers are the upper halves of the even registers before them. */
const pairs: Snippet[] = [
  snip('FR=0 mtc1 to an odd register', 'mtc1 $t0, $f1', { t0: 0x11223344 }, {}, { fr: 0, expectF: { f0: 0x1122334400000000n } }),
  snip('FR=0 mfc1 from an odd register', 'mfc1 $t0, $f3', {}, { t0: SX(0x80000000n) }, {
    fr: 0, fregs: { f2: 0x8000000012345678n }, expectF: { f2: 0x8000000012345678n },
  }),
  snip('FR=0 lwc1 to an odd register keeps the even half', 'lwc1 $f1, 0($t1)', { t1: D }, {}, {
    fr: 0, mem: [words(D, 0xcafebabe)], fregs: { f0: 0x55n }, expectF: { f0: 0xcafebabe00000055n },
  }),
  snip('FR=0 doubles use the even register', 'ldc1 $f2, 0($t1)\nadd.d $f4, $f2, $f2', { t1: D }, {}, {
    fr: 0, mem: [dwords(D, d(1.25))], expectF: { f2: d(1.25), f4: d(2.5) },
  }),
  snip('FR=0 single arithmetic on odd registers', 'add.s $f1, $f3, $f5', {}, {}, {
    fr: 0, fregs: { f2: s(1) << 32n, f4: s(2) << 32n }, expectF: { f0: s(3) << 32n, f2: s(1) << 32n, f4: s(2) << 32n },
  }),
  snip('FR=1 odd registers are separate', 'ldc1 $f1, 0($t1)\nldc1 $f0, 8($t1)', { t1: D }, {}, {
    mem: [dwords(D, 0x0102030405060708n, 0x1112131415161718n)], expectF: { f1: 0x0102030405060708n, f0: 0x1112131415161718n },
  }),
];

const NAMES = ['f', 'un', 'eq', 'ueq', 'olt', 'ult', 'ole', 'ule', 'sf', 'ngle', 'seq', 'ngl', 'lt', 'nge', 'le', 'ngt'];
const OPERANDS: [string, number, number][] = [['less', 1, 2], ['equal', 2, 2], ['greater', 3, 2], ['unordered', NaN, 2]];

/** Whether condition `cond` holds when the operands stand in relation `rel`. */
function holds(cond: number, rel: string): boolean {
  const k = cond & 7;
  const [un, eq, lt] = [rel === 'unordered', rel === 'equal', rel === 'less'];
  return ((k & 1) !== 0 && un) || ((k & 2) !== 0 && eq) || ((k & 4) !== 0 && lt);
}

const compares: Snippet[] = [];
for (const fmt of ['s', 'd'] as const) {
  const enc = fmt === 's' ? s : d;
  NAMES.forEach((name, cond) => {
    for (const [rel, a, b] of OPERANDS) {
      compares.push(snip(`c.${name}.${fmt} on ${rel} operands`, `c.${name}.${fmt} $f2, $f4`, {}, {}, {
        fregs: { f2: enc(a), f4: enc(b) }, expectF: { f2: enc(a), f4: enc(b) }, expectFcsr: holds(cond, rel) ? COND : 0,
      }));
    }
  });
}
compares.push(
  snip('a compare clears a set condition bit', 'c.eq.s $f2, $f4', {}, {}, {
    fcsr: COND | 3, fregs: { f2: s(1), f4: s(2) }, expectF: { f2: s(1), f4: s(2) }, expectFcsr: 3,
  }),
);

/** A COP1 branch with markers in the delay slot ($t5), on the fall-through path ($t6) and at the target ($t7). */
function bc1(insn: string, fcsr: number, taken: boolean): Snippet {
  const likely = /l\s/.test(insn);
  const asm = `
    ${insn}
    addiu $t5, $t5, 1
    addiu $t6, $t6, 1
    jr $ra
    nop
  target:
    addiu $t7, $t7, 1
    jr $ra
    nop`;
  const slot = taken || !likely ? 1 : 0;
  return full(`${insn.replace('target', '')}(fcsr ${fcsr ? 'true' : 'false'}) ${taken ? 'taken' : 'not taken'}`, asm, {},
    taken ? { t5: slot, t7: 1 } : { t5: slot, t6: 1 }, { fcsr, expectFcsr: fcsr });
}

const branches: Snippet[] = [];
for (const l of ['', 'l']) {
  branches.push(
    bc1(`bc1t${l} target`, COND, true), bc1(`bc1t${l} target`, 0, false),
    bc1(`bc1f${l} target`, 0, true), bc1(`bc1f${l} target`, COND, false),
  );
}
branches.push(
  full('compare then branch', `
    c.lt.s $f2, $f4
    nop
    bc1t yes
    nop
    jr $ra
    nop
  yes:
    addiu $t0, $zero, 7
    jr $ra
    nop`, {}, { t0: 7 }, { fregs: { f2: s(1), f4: s(2) }, expectF: { f2: s(1), f4: s(2) }, expectFcsr: COND }),
  snip('an FPU instruction in a delay slot', 'beq $zero, $zero, done\nadd.s $f0, $f2, $f4\ndone:', {}, {}, {
    fregs: { f2: s(1), f4: s(1) }, expectF: { f0: s(2), f2: s(1), f4: s(1) },
  }),
);

snippetSuite('COP1 arithmetic', arithmetic);
snippetSuite('COP1 conversions', conversions);
snippetSuite('COP1 moves and loads', moves);
snippetSuite('COP1 FR=0 register pairs', pairs);
snippetSuite('COP1 compares', compares);
snippetSuite('COP1 branches', branches);
