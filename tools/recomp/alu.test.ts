import { snip, snippetSuite } from './suite.ts';

const NEG = 0xffffffffffffffffn;
const MIN32 = 0xffffffff80000000n;

snippetSuite('integer ALU', [
  // 32-bit arithmetic sign-extends the low word of the result and ignores the upper input bits.
  snip('addu wraps and sign-extends', 'addu $t0, $t1, $t2', { t1: 0x7fffffff, t2: 1 }, { t0: MIN32 }),
  snip('addu ignores upper input bits', 'addu $t0, $t1, $t2', { t1: 0x100000001n, t2: 2 }, { t0: 3 }),
  snip('subu borrows', 'subu $t0, $t1, $t2', { t1: 0, t2: 1 }, { t0: NEG }),
  snip('add without overflow', 'add $t0, $t1, $t2', { t1: 5, t2: -7 }, { t0: -2 }),
  snip('add -1 + 1 is not an overflow', 'add $t0, $t1, $t2', { t1: NEG, t2: 1 }, { t0: 0 }),
  snip('sub without overflow', 'sub $t0, $t1, $t2', { t1: 5, t2: 7 }, { t0: -2 }),
  snip('addi without overflow', 'addi $t0, $t1, -3', { t1: 1 }, { t0: -2 }),
  snip('addiu wraps and sign-extends', 'addiu $t0, $t1, 1', { t1: 0x7fffffff }, { t0: MIN32 }),
  snip('addiu negative immediate', 'addiu $t0, $t1, -1', { t1: 0 }, { t0: NEG }),
  snip('addu into $zero is discarded', 'addu $zero, $t1, $t2', { t1: 1, t2: 2 }, {}),

  snip('and', 'and $t0, $t1, $t2', { t1: 0xf0f0f0f0f0f0f0f0n, t2: 0x00ff00ff00ff00ffn }, { t0: 0x00f000f000f000f0n }),
  snip('or', 'or $t0, $t1, $t2', { t1: 0xf0f0f0f0f0f0f0f0n, t2: 0x00ff00ff00ff00ffn }, { t0: 0xf0fff0fff0fff0ffn }),
  snip('xor', 'xor $t0, $t1, $t2', { t1: 0xf0f0f0f0f0f0f0f0n, t2: 0x00ff00ff00ff00ffn }, { t0: 0xf00ff00ff00ff00fn }),
  snip('nor', 'nor $t0, $t1, $t2', { t1: 0xf0f0f0f0f0f0f0f0n, t2: 0x00ff00ff00ff00ffn }, { t0: 0x0f000f000f000f00n }),
  snip('andi zero-extends the immediate', 'andi $t0, $t1, 0x8000', { t1: NEG }, { t0: 0x8000 }),
  snip('ori zero-extends the immediate', 'ori $t0, $t1, 0xffff', { t1: 0 }, { t0: 0xffff }),
  snip('xori', 'xori $t0, $t1, 0xffff', { t1: 0xff00 }, { t0: 0x00ff }),
  snip('lui sign-extends', 'lui $t0, 0x8000', {}, { t0: MIN32 }),
  snip('lui positive', 'lui $t0, 0x1234', { t0: NEG }, { t0: 0x12340000 }),
  snip('move', 'move $t0, $t1', { t1: 0x123456789n }, { t0: 0x123456789n }),

  // Comparisons look at all 64 bits.
  snip('slt signed', 'slt $t0, $t1, $t2', { t1: -1, t2: 1 }, { t0: 1 }),
  snip('sltu unsigned', 'sltu $t0, $t1, $t2', { t1: -1, t2: 1 }, { t0: 0 }),
  snip('slt compares 64 bits', 'slt $t0, $t1, $t2', { t1: 0x80000000, t2: 1 }, { t0: 0 }),
  snip('slt equal', 'slt $t0, $t1, $t2', { t0: 9, t1: 4, t2: 4 }, { t0: 0 }),
  snip('slti', 'slti $t0, $t1, -4', { t1: -5 }, { t0: 1 }),
  snip('slti false', 'slti $t0, $t1, -4', { t1: -3 }, { t0: 0 }),
  snip('sltiu sign-extends the immediate', 'sltiu $t0, $t1, -1', { t1: 5 }, { t0: 1 }),
  snip('sltiu against the maximum', 'sltiu $t0, $t1, -1', { t1: NEG }, { t0: 0 }),

  snip('sll', 'sll $t0, $t1, 4', { t1: 1 }, { t0: 16 }),
  snip('sll into the sign bit', 'sll $t0, $t1, 31', { t1: 1 }, { t0: MIN32 }),
  snip('sll drops the upper word', 'sll $t0, $t1, 4', { t1: 0x100000001n }, { t0: 0x10 }),
  snip('srl', 'srl $t0, $t1, 4', { t1: MIN32 }, { t0: 0x08000000 }),
  snip('srl by zero sign-extends', 'srl $t0, $t1, 0', { t1: MIN32 }, { t0: MIN32 }),
  snip('sra', 'sra $t0, $t1, 4', { t1: MIN32 }, { t0: 0xfffffffff8000000n }),
  snip('sra uses the low word only', 'sra $t0, $t1, 4', { t1: 0x80000000 }, { t0: 0xfffffffff8000000n }),
  snip('sllv masks the amount to 5 bits', 'sllv $t0, $t1, $t2', { t1: 3, t2: 33 }, { t0: 6 }),
  snip('srlv', 'srlv $t0, $t1, $t2', { t1: 0x80000000, t2: 31 }, { t0: 1 }),
  snip('srav masks the amount to 5 bits', 'srav $t0, $t1, $t2', { t1: MIN32, t2: 63 }, { t0: NEG }),
  snip('nop leaves everything', 'nop', { t0: 5 }, {}),

  snip('dsll does not sign-extend', 'dsll $t0, $t1, 31', { t1: 1 }, { t0: 0x80000000 }),
  snip('dsrl', 'dsrl $t0, $t1, 31', { t1: 0x8000000000000000n }, { t0: 0x100000000n }),
  snip('dsra', 'dsra $t0, $t1, 31', { t1: 0x8000000000000000n }, { t0: 0xffffffff00000000n }),
  snip('dsll32', 'dsll32 $t0, $t1, 0', { t1: 1 }, { t0: 0x100000000n }),
  snip('dsll32 by 31', 'dsll32 $t0, $t1, 31', { t1: 1 }, { t0: 0x8000000000000000n }),
  snip('dsrl32', 'dsrl32 $t0, $t1, 0', { t1: 0x8000000000000000n }, { t0: 0x80000000 }),
  snip('dsra32', 'dsra32 $t0, $t1, 0', { t1: 0xfffffffe00000000n }, { t0: 0xfffffffffffffffen }),
  snip('dsra32 by 31', 'dsra32 $t0, $t1, 31', { t1: 0x8000000000000000n }, { t0: NEG }),
  snip('dsllv masks the amount to 6 bits', 'dsllv $t0, $t1, $t2', { t1: 1, t2: 0x7f }, { t0: 0x8000000000000000n }),
  snip('dsrlv', 'dsrlv $t0, $t1, $t2', { t1: 0x8000000000000000n, t2: 65 }, { t0: 0x4000000000000000n }),
  snip('dsrav', 'dsrav $t0, $t1, $t2', { t1: 0x8000000000000000n, t2: 1 }, { t0: 0xc000000000000000n }),

  snip('daddu', 'daddu $t0, $t1, $t2', { t1: NEG, t2: 1 }, { t0: 0 }),
  snip('dsubu', 'dsubu $t0, $t1, $t2', { t1: 0, t2: 1 }, { t0: NEG }),
  snip('daddiu does not sign-extend the sum', 'daddiu $t0, $t1, 1', { t1: 0x7fffffff }, { t0: 0x80000000 }),
  snip('daddiu negative immediate', 'daddiu $t0, $t1, -1', { t1: 0 }, { t0: NEG }),
  snip('dadd without overflow', 'dadd $t0, $t1, $t2', { t1: 1, t2: -2 }, { t0: NEG }),
  snip('dsub without overflow', 'dsub $t0, $t1, $t2', { t1: 1, t2: 2 }, { t0: NEG }),
  snip('daddi without overflow', 'daddi $t0, $t1, -2', { t1: 1 }, { t0: NEG }),


  snip('mthi/mtlo/mfhi/mflo', 'mthi $t1\nmtlo $t2\nmfhi $t3\nmflo $t4', { t1: 0x1111, t2: 0x2222 }, { hi: 0x1111, lo: 0x2222, t3: 0x1111, t4: 0x2222 }),
  snip('mfhi/mflo move all 64 bits', 'mfhi $t0\nmflo $t1', { hi: 0x123456789abcdef0n, lo: NEG }, { t0: 0x123456789abcdef0n, t1: NEG }),

  // Exceptions: the destination keeps its old value and the exception is raised at the instruction.
  snip('add overflow', 'add $t0, $t1, $t2', { t0: 77, t1: 0x7fffffff, t2: 1 }, {}, { trap: { kind: 'overflow', pc: 0x80001000 } }),
  snip('add negative overflow', 'add $t0, $t1, $t2', { t0: 77, t1: MIN32, t2: NEG }, {}, { trap: { kind: 'overflow' } }),
  snip('sub overflow', 'sub $t0, $t1, $t2', { t0: 77, t1: MIN32, t2: 1 }, {}, { trap: { kind: 'overflow' } }),
  snip('addi overflow', 'addi $t0, $t1, 1', { t0: 77, t1: 0x7fffffff }, {}, { trap: { kind: 'overflow' } }),
  snip('dadd overflow', 'dadd $t0, $t1, $t2', { t0: 77, t1: 0x7fffffffffffffffn, t2: 1 }, {}, { trap: { kind: 'overflow' } }),
  snip('dsub overflow', 'dsub $t0, $t1, $t2', { t0: 77, t1: 0x8000000000000000n, t2: 1 }, {}, { trap: { kind: 'overflow' } }),
  snip('daddi overflow', 'daddi $t0, $t1, 1', { t0: 77, t1: 0x7fffffffffffffffn }, {}, { trap: { kind: 'overflow' } }),
  snip('overflow reports the faulting pc', 'nop\nnop\nadd $t0, $t1, $t2', { t1: 0x7fffffff, t2: 1 }, {}, { trap: { kind: 'overflow', pc: 0x80001008 } }),
]);
