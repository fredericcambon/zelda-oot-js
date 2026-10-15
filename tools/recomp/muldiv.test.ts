import { snip, snippetSuite } from './suite.ts';

const NEG = 0xffffffffffffffffn;

snippetSuite('multiply and divide', [
  // 32-bit results: LO and HI each hold a sign-extended word.
  snip('mult negative', 'mult $t1, $t2', { t1: -3, t2: 5 }, { lo: -15, hi: NEG }),
  snip('mult positive with high word', 'mult $t1, $t2', { t1: 0x7fffffff, t2: 0x7fffffff }, { lo: 1, hi: 0x3fffffff }),
  snip('mult of the minimum with itself', 'mult $t1, $t2', { t1: 0x80000000, t2: 0x80000000 }, { lo: 0, hi: 0x40000000 }),
  snip('mult low word sign-extends', 'mult $t1, $t2', { t1: 0x10000, t2: 0x8000 }, { lo: 0xffffffff80000000n, hi: 0 }),
  snip('mult uses only the low words', 'mult $t1, $t2', { t1: 0x500000003n, t2: 0x700000002n }, { lo: 6, hi: 0 }),
  snip('multu max by max', 'multu $t1, $t2', { t1: NEG, t2: NEG }, { lo: 1, hi: 0xfffffffffffffffen }),
  snip('multu small', 'multu $t1, $t2', { t1: 0x10000, t2: 0x10000 }, { lo: 0, hi: 1 }),
  snip('mult then mflo/mfhi', 'mult $t1, $t2\nmflo $t3\nmfhi $t4', { t1: -3, t2: 5 }, { lo: -15, hi: NEG, t3: -15, t4: NEG }),

  snip('div truncates toward zero', 'div $t1, $t2', { t1: 7, t2: -2 }, { lo: -3, hi: 1 }),
  snip('div negative dividend', 'div $t1, $t2', { t1: -7, t2: 2 }, { lo: -3, hi: NEG }),
  snip('div exact', 'div $t1, $t2', { t1: 100, t2: 10 }, { lo: 10, hi: 0 }),
  snip('div reads the low words', 'div $t1, $t2', { t1: 0x100000007n, t2: 0x200000002n }, { lo: 3, hi: 1 }),
  snip('divu large dividend', 'divu $t1, $t2', { t1: 0xffffffff, t2: 16 }, { lo: 0x0fffffff, hi: 15 }),
  snip('divu result sign-extends', 'divu $t1, $t2', { t1: 0xfffffffe, t2: 1 }, { lo: 0xfffffffffffffffen, hi: 0 }),
  snip('div minimum by -1 wraps', 'div $t1, $t2', { t1: 0x80000000, t2: -1 }, { lo: 0xffffffff80000000n, hi: 0 }),
  // The manual leaves division by zero unpredictable; the runtime fixes these results.
  snip('div by zero, positive dividend', 'div $t1, $t2', { t1: 5, t2: 0 }, { lo: NEG, hi: 5 }),
  snip('div by zero, negative dividend', 'div $t1, $t2', { t1: -5, t2: 0 }, { lo: 1, hi: -5 }),
  snip('divu by zero', 'divu $t1, $t2', { t1: 0x80000000, t2: 0 }, { lo: NEG, hi: 0xffffffff80000000n }),

  // 64-bit results.
  snip('dmult negative', 'dmult $t1, $t2', { t1: -3, t2: 5 }, { lo: -15, hi: NEG }),
  snip('dmult positive', 'dmult $t1, $t2', { t1: 0x7fffffffffffffffn, t2: 2 }, { lo: 0xfffffffffffffffen, hi: 0 }),
  snip('dmult of the minimum with itself', 'dmult $t1, $t2', { t1: 0x8000000000000000n, t2: 0x8000000000000000n }, { lo: 0, hi: 0x4000000000000000n }),
  snip('dmultu max by max', 'dmultu $t1, $t2', { t1: NEG, t2: NEG }, { lo: 1, hi: 0xfffffffffffffffen }),
  snip('ddiv negative dividend', 'ddiv $t1, $t2', { t1: -7, t2: 2 }, { lo: -3, hi: NEG }),
  snip('ddiv large', 'ddiv $t1, $t2', { t1: 0x123456789abcdef0n, t2: 0x10000 }, { lo: 0x123456789abcn, hi: 0xdef0 }),
  snip('ddiv minimum by -1 wraps', 'ddiv $t1, $t2', { t1: 0x8000000000000000n, t2: -1 }, { lo: 0x8000000000000000n, hi: 0 }),
  snip('ddivu max by 10', 'ddivu $t1, $t2', { t1: NEG, t2: 10 }, { lo: 0x1999999999999999n, hi: 5 }),
  snip('ddiv by zero', 'ddiv $t1, $t2', { t1: 9, t2: 0 }, { lo: NEG, hi: 9 }),
  snip('ddivu by zero', 'ddivu $t1, $t2', { t1: 9, t2: 0 }, { lo: NEG, hi: 9 }),
]);
