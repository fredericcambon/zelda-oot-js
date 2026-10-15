import { bytes, DATA_BASE as D, dwords, words } from './harness.ts';
import { snip, snippetSuite } from './suite.ts';

const NEG = 0xffffffffffffffffn;

// Sixteen bytes of test data with the sign bit set in several places.
const DATA = bytes(D, 0x81, 0x02, 0x03, 0x84, 0xf5, 0x06, 0x07, 0x08, 0x89, 0x9a, 0xab, 0xbc, 0xcd, 0xde, 0xef, 0xf0);
// Ascending bytes, to follow where unaligned accesses land.
const ASC = bytes(D, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff);
const SRC = 0x1234567890abcdefn;

snippetSuite('loads and stores', [
  snip('lb sign-extends', 'lb $t0, 0($t1)', { t1: D }, { t0: 0xffffffffffffff81n }, { mem: [DATA] }),
  snip('lb positive at an offset', 'lb $t0, 1($t1)', { t1: D }, { t0: 2 }, { mem: [DATA] }),
  snip('lbu zero-extends', 'lbu $t0, 0($t1)', { t1: D }, { t0: 0x81 }, { mem: [DATA] }),
  snip('lh sign-extends', 'lh $t0, 0($t1)', { t1: D }, { t0: 0xffffffffffff8102n }, { mem: [DATA] }),
  snip('lhu zero-extends', 'lhu $t0, 0($t1)', { t1: D }, { t0: 0x8102 }, { mem: [DATA] }),
  snip('lw sign-extends', 'lw $t0, 0($t1)', { t1: D }, { t0: 0xffffffff81020384n }, { mem: [DATA] }),
  snip('lw positive word at an offset', 'lw $t0, 8($t1)', { t1: D }, { t0: 0xffffffff899aabbcn }, { mem: [DATA] }),
  snip('lw of 0x00ff0102', 'lw $t0, 0($t1)', { t1: D }, { t0: 0x00ff0102 }, { mem: [words(D, 0x00ff0102)] }),
  snip('lwu zero-extends', 'lwu $t0, 0($t1)', { t1: D }, { t0: 0x81020384 }, { mem: [DATA] }),
  snip('ld', 'ld $t0, 0($t1)', { t1: D }, { t0: 0x81020384f5060708n }, { mem: [DATA] }),
  snip('ld second doubleword', 'ld $t0, 8($t1)', { t1: D }, { t0: 0x899aabbccddeeff0n }, { mem: [DATA] }),
  snip('load with a negative offset', 'lw $t0, -8($t1)', { t1: D + 8 }, { t0: 0xffffffff81020384n }, { mem: [DATA] }),
  snip('load through the uncached segment', 'lw $t0, 0($t1)', { t1: 0xffffffffa0002000n }, { t0: 0xffffffff81020384n }, { mem: [DATA] }),
  snip('load address ignores the upper register half', 'lw $t0, 0($t1)', { t1: 0x500000000n + BigInt(D) }, { t0: 0xffffffff81020384n }, { mem: [DATA] }),
  snip('load into $zero is discarded', 'lw $zero, 0($t1)', { t1: D }, {}, { mem: [DATA] }),
  snip('cache is a no-op', 'cache $21, 0($t1)', { t1: D }, {}, { mem: [DATA] }),

  snip('sb', 'sb $t2, 3($t1)', { t1: D, t2: SRC }, {}, { expectMem: [bytes(D + 3, 0xef)] }),
  snip('sh', 'sh $t2, 2($t1)', { t1: D, t2: SRC }, {}, { expectMem: [bytes(D + 2, 0xcd, 0xef)] }),
  snip('sw', 'sw $t2, 4($t1)', { t1: D, t2: SRC }, {}, { expectMem: [words(D + 4, 0x90abcdef)] }),
  snip('sd', 'sd $t2, 8($t1)', { t1: D, t2: SRC }, {}, { expectMem: [dwords(D + 8, SRC)] }),
  snip('store does not touch neighbours', 'sh $t2, 2($t1)', { t1: D, t2: SRC }, {}, { mem: [DATA], expectMem: [bytes(D + 2, 0xcd, 0xef)] }),
  snip('store a register read back', 'sw $t2, 0($t1)\nlw $t3, 0($t1)', { t1: D, t2: 0x80000001 }, { t3: 0xffffffff80000001n }, { expectMem: [words(D, 0x80000001)] }),
  snip('store $zero', 'sw $zero, 0($t1)', { t1: D }, {}, { mem: [DATA], expectMem: [words(D, 0)] }),

  // Unaligned access: a pair of lwl/lwr (or swl/swr) at offsets 0 and 3 handles any alignment.
  snip('lwl+lwr load an unaligned word', 'lwl $t0, 0($t1)\nlwr $t0, 3($t1)', { t1: D + 1 }, { t0: 0x11223344 }, { mem: [ASC] }),
  snip('lwl+lwr sign-extend the word', 'lwl $t0, 0($t1)\nlwr $t0, 3($t1)', { t1: D + 9 }, { t0: 0xfffffffff1f2f3f4n }, { mem: [bytes(D + 8, 0x00, 0xf1, 0xf2, 0xf3, 0xf4)] }),
  snip('lwl+lwr on an aligned address', 'lwl $t0, 0($t1)\nlwr $t0, 3($t1)', { t1: D }, { t0: 0x00112233 }, { mem: [ASC] }),
  snip('lwl aligned replaces the whole register', 'lwl $t0, 0($t1)', { t0: 0xdeadbeefdeadbeefn, t1: D }, { t0: 0x00112233 }, { mem: [ASC] }),
  snip('lwl at offset 3 keeps the low bytes', 'lwl $t0, 3($t1)', { t0: 0x1111111111111111n, t1: D }, { t0: 0x33111111 }, { mem: [ASC] }),
  snip('lwr at offset 0 keeps the upper bytes', 'lwr $t0, 0($t1)', { t0: 0xdeadbeef12345678n, t1: D }, { t0: 0xdeadbeef12345600n }, { mem: [ASC] }),
  snip('lwr at offset 3 loads the whole word', 'lwr $t0, 3($t1)', { t0: 0xdeadbeef12345678n, t1: D }, { t0: 0x00112233 }, { mem: [ASC] }),
  snip('swl+swr store an unaligned word', 'swl $t2, 0($t1)\nswr $t2, 3($t1)', { t1: D + 1, t2: 0x11223344 }, {}, { expectMem: [bytes(D + 1, 0x11, 0x22, 0x33, 0x44)] }),
  snip('swl+swr leave the neighbouring bytes', 'swl $t2, 0($t1)\nswr $t2, 3($t1)', { t1: D + 1, t2: 0x11223344 }, {}, { mem: [bytes(D, 0xaa)], expectMem: [bytes(D, 0xaa, 0x11, 0x22, 0x33, 0x44)] }),
  snip('swl alone stores the high bytes', 'swl $t2, 2($t1)', { t1: D, t2: 0x11223344 }, {}, { expectMem: [bytes(D, 0, 0, 0x11, 0x22)] }),
  snip('swr alone stores the low bytes', 'swr $t2, 2($t1)', { t1: D, t2: 0x11223344 }, {}, { expectMem: [bytes(D, 0x22, 0x33, 0x44)] }),
  snip('ldl+ldr load an unaligned doubleword', 'ldl $t0, 0($t1)\nldr $t0, 7($t1)', { t1: D + 3 }, { t0: 0x33445566778899aan }, { mem: [ASC] }),
  snip('ldl+ldr on an aligned address', 'ldl $t0, 0($t1)\nldr $t0, 7($t1)', { t1: D }, { t0: 0x0011223344556677n }, { mem: [ASC] }),
  snip('ldl at offset 3 keeps the low bytes', 'ldl $t0, 3($t1)', { t0: NEG, t1: D }, { t0: 0x3344556677ffffffn }, { mem: [ASC] }),
  snip('ldr at offset 0 keeps the upper bytes', 'ldr $t0, 0($t1)', { t0: NEG, t1: D }, { t0: 0xffffffffffffff00n }, { mem: [ASC] }),
  snip('sdl+sdr store an unaligned doubleword', 'sdl $t2, 0($t1)\nsdr $t2, 7($t1)', { t1: D + 3, t2: 0x0102030405060708n }, {}, { expectMem: [bytes(D + 3, 1, 2, 3, 4, 5, 6, 7, 8)] }),
  snip('sdl alone stores the high bytes', 'sdl $t2, 5($t1)', { t1: D, t2: 0x0102030405060708n }, {}, { expectMem: [bytes(D, 0, 0, 0, 0, 0, 1, 2, 3)] }),
  snip('sdr alone stores the low bytes', 'sdr $t2, 5($t1)', { t1: D, t2: 0x0102030405060708n }, {}, { expectMem: [bytes(D, 3, 4, 5, 6, 7, 8)] }),

  snip('ll and sc increment a word', 'll $t0, 0($t1)\naddiu $t0, $t0, 1\nsc $t0, 0($t1)', { t1: D }, { t0: 1 }, { mem: [words(D, 5)], expectMem: [words(D, 6)] }),
  snip('sc without ll fails', 'sc $t0, 0($t1)', { t0: 99, t1: D }, { t0: 0 }, { mem: [words(D, 5)] }),
  snip('sc after sc fails', 'll $t0, 0($t1)\nsc $t0, 0($t1)\nsc $t0, 0($t1)', { t1: D }, { t0: 0 }, { mem: [words(D, 5)] }),
  snip('lld and scd increment a doubleword', 'lld $t0, 0($t1)\ndaddiu $t0, $t0, 1\nscd $t0, 0($t1)', { t1: D }, { t0: 1 }, { mem: [dwords(D, 0x1ffffffffn)], expectMem: [dwords(D, 0x200000000n)] }),
  snip('scd without lld fails', 'scd $t0, 0($t1)', { t0: 99, t1: D }, { t0: 0 }, { mem: [dwords(D, 5)] }),
]);
