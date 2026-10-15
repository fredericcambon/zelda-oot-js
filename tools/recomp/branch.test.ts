import { DATA_BASE as D, words } from './harness.ts';
import type { Snippet } from './harness.ts';
import { full, snip, snippetSuite } from './suite.ts';

const NEG = 0xffffffffffffffffn;
const MIN32 = 0xffffffff80000000n;
const ENTRY = 0x80001000;

/**
 * A conditional branch with a marker in its delay slot ($t5), on the fall-through path ($t6) and at the
 * target ($t7). A likely branch annuls the delay slot when it is not taken.
 */
function cond(insn: string, init: Snippet['regs'], taken: boolean): Snippet {
  const likely = /^b\w+l\s/.test(insn);
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
  return full(`${insn.replace('target', '')}(${Object.values(init ?? {}).join(', ')}) ${taken ? 'taken' : 'not taken'}`, asm, init,
    taken ? { t5: slot, t7: 1 } : { t5: slot, t6: 1 });
}

const conds: Snippet[] = [];
for (const l of ['', 'l']) {
  conds.push(
    cond(`beq${l} $t1, $t2, target`, { t1: 3, t2: 3 }, true),
    cond(`beq${l} $t1, $t2, target`, { t1: 3, t2: 4 }, false),
    cond(`beq${l} $t1, $t2, target`, { t1: 0x100000003n, t2: 3 }, false),
    cond(`bne${l} $t1, $t2, target`, { t1: 3, t2: 4 }, true),
    cond(`bne${l} $t1, $t2, target`, { t1: 3, t2: 3 }, false),
    cond(`bne${l} $t1, $t2, target`, { t1: 0x100000003n, t2: 3 }, true),
    cond(`blez${l} $t1, target`, { t1: 0 }, true),
    cond(`blez${l} $t1, target`, { t1: -1 }, true),
    cond(`blez${l} $t1, target`, { t1: 1 }, false),
    cond(`blez${l} $t1, target`, { t1: 0x80000000 }, false),
    cond(`bgtz${l} $t1, target`, { t1: 1 }, true),
    cond(`bgtz${l} $t1, target`, { t1: 0x80000000 }, true),
    cond(`bgtz${l} $t1, target`, { t1: 0 }, false),
    cond(`bgtz${l} $t1, target`, { t1: -1 }, false),
    cond(`bltz${l} $t1, target`, { t1: -1 }, true),
    cond(`bltz${l} $t1, target`, { t1: MIN32 }, true),
    cond(`bltz${l} $t1, target`, { t1: 0 }, false),
    cond(`bltz${l} $t1, target`, { t1: 0x80000000 }, false),
    cond(`bgez${l} $t1, target`, { t1: 0 }, true),
    cond(`bgez${l} $t1, target`, { t1: 0x80000000 }, true),
    cond(`bgez${l} $t1, target`, { t1: NEG }, false),
  );
}

/** A branch-and-link to `sub` (which increments $t7), then the code after the delay slot ($t6). */
function link(insn: string, init: Snippet['regs'], taken: boolean, likely: boolean): Snippet {
  const asm = `
    ${insn}
    addiu $t5, $t5, 1
    addiu $t6, $t6, 1
    jr $ra
    nop
    .func
  sub:
    addiu $t7, $t7, 1
    jr $ra
    nop`;
  return full(`${insn} ${taken ? 'taken' : 'not taken'}`, asm, init,
    { t5: taken || !likely ? 1 : 0, t6: 1, t7: taken ? 1 : 0, ra: ENTRY + 8 });
}

const FUNC = (name: string, body: string) => `
  .func
${name}:
${body}
  jr $ra
  nop`;

// A branch target may be the delay slot of another branch: the slot runs, then execution continues
// with the instruction after it.
const slotTargets: { name: string; init: Record<string, number>; want: Record<string, number> }[] = [
  { name: 'jumping into the slot', init: { t5: 1, t1: 0 }, want: { t5: 1, t2: 1, t3: 10 } },
  { name: 'taking the branch that owns the slot', init: { t5: 0, t1: 0 }, want: { t2: 1 } },
  { name: 'not taking the branch that owns the slot', init: { t5: 0, t1: 1 }, want: { t1: 1, t2: 1, t3: 10 } },
];

snippetSuite('branches', [
  ...conds,

  link('bltzal $t1, sub', { t1: -1 }, true, false),
  link('bltzal $t1, sub', { t1: 1, ra: 0x1234 }, false, false),
  link('bgezal $t1, sub', { t1: 0 }, true, false),
  link('bgezal $t1, sub', { t1: -1, ra: 0x1234 }, false, false),
  link('bltzall $t1, sub', { t1: -1 }, true, true),
  link('bltzall $t1, sub', { t1: 1, ra: 0x1234 }, false, true),
  link('bgezall $t1, sub', { t1: 0 }, true, true),
  link('bgezall $t1, sub', { t1: -1, ra: 0x1234 }, false, true),
  link('bal sub', {}, true, false),

  full('branch compares the registers before the delay slot changes them', `
    beq $t1, $t2, target
    addiu $t1, $t1, 1
    jr $ra
    nop
  target:
    addiu $t7, $t7, 1
    jr $ra
    nop`, { t1: 1, t2: 1 }, { t1: 2, t7: 1 }),
  full('bltz decides before its delay slot clears the register', `
    bltz $t1, target
    move $t1, $zero
    jr $ra
    nop
  target:
    addiu $t7, $t7, 1
    jr $ra
    nop`, { t1: -1 }, { t1: 0, t7: 1 }),
  full('likely branch decides before its delay slot clears the register', `
    bnel $t1, $zero, target
    move $t1, $zero
    jr $ra
    nop
  target:
    addiu $t7, $t7, 1
    jr $ra
    nop`, { t1: 9 }, { t1: 0, t7: 1 }),

  full('backward branch loop', `
  loop:
    addu $t0, $t0, $t1
    addiu $t1, $t1, -1
    bne $t1, $zero, loop
    nop
    jr $ra
    nop`, { t1: 5 }, { t0: 15, t1: 0 }),
  full('likely backward loop runs its delay slot only when taken', `
  loop:
    addiu $t0, $t0, 1
    addiu $t1, $t1, -1
    bnel $t1, $zero, loop
    addiu $t2, $t2, 1
    jr $ra
    nop`, { t1: 3 }, { t0: 3, t1: 0, t2: 2 }),
  full('unconditional b', `
    b target
    addiu $t5, $t5, 1
    addiu $t6, $t6, 1
  target:
    addiu $t7, $t7, 1
    jr $ra
    nop`, {}, { t5: 1, t7: 1 }),

  full('j runs the delay slot and skips ahead', `
    j target
    addiu $t5, $t5, 1
    addiu $t6, $t6, 1
  target:
    addiu $t7, $t7, 1
    jr $ra
    nop`, {}, { t5: 1, t7: 1 }),
  full('jal calls and returns to the instruction after the delay slot', `
    jal f
    addiu $t5, $t5, 1
    addiu $t6, $t6, 1
    jr $ra
    nop
  ${FUNC('f', '    addiu $v0, $v0, 5')}`, {}, { t5: 1, t6: 1, v0: 5, ra: ENTRY + 8 }),
  full('jal delay slot sees the link register', `
    jal f
    move $t0, $ra
    jr $ra
    nop
  ${FUNC('f', '    addiu $v0, $v0, 5')}`, {}, { t0: ENTRY + 8, v0: 5, ra: ENTRY + 8 }),
  full('nested calls with the return address saved on the stack', `
    addiu $sp, $sp, -8
    sw $ra, 0($sp)
    jal f
    nop
    lw $ra, 0($sp)
    addiu $sp, $sp, 8
    jr $ra
    nop
  ${FUNC('f', '    addiu $v0, $v0, 1\n    addiu $sp, $sp, -8\n    sw $ra, 0($sp)\n    jal g\n    nop\n    lw $ra, 0($sp)\n    addiu $sp, $sp, 8')}
  ${FUNC('g', '    addiu $v0, $v0, 10')}`, { sp: D + 0x100, ra: 0x80005555 }, { v0: 11, sp: 0xffffffff80002100n, ra: 0xffffffff80005555n },
  { expectMem: [words(D + 0xf8, 0x80005555), words(D + 0xf0, 0x80001010)] }),
  full('jalr links in $ra by default', `
    jalr $t9
    addiu $t5, $t5, 1
    addiu $t6, $t6, 1
    jr $ra
    nop
    .org 0x80001040
    addiu $v0, $v0, 7
    jr $ra
    nop`, { t9: 0x80001040 }, { t5: 1, t6: 1, v0: 7, ra: ENTRY + 8 }),
  full('jalr with another link register', `
    jalr $t0, $t9
    nop
    jr $ra
    nop
    .org 0x80001040
    addiu $v0, $v0, 7
    jr $ra
    nop`, { t9: 0x80001040 }, { t0: ENTRY + 8, v0: 7 }),
  full('jr to another function is a tail call that uses the target from before the delay slot', `
    jr $t9
    addiu $t9, $t9, 4
    .org 0x80001040
    addiu $v0, $v0, 7
    jr $ra
    nop`, { t9: 0x80001040 }, { t9: 0xffffffff80001044n, v0: 7 }),
  full('jalr to an unknown address stops', `
    jalr $t9
    nop
    jr $ra
    nop`, { t9: 0x80009000 }, { ra: ENTRY + 8 }, { trap: { kind: 'unmapped', pc: 0x80009000 } }),

  full('branch to another function is a tail call', `
    bne $t1, $zero, other
    addiu $t5, $t5, 1
    addiu $t6, $t6, 1
    jr $ra
    nop
    .org 0x80001040
  other:
    addiu $v0, $v0, 7
    jr $ra
    nop`, { t1: 1 }, { t5: 1, v0: 7 }),
  full('not taken branch to another function falls through', `
    bne $t1, $zero, other
    addiu $t5, $t5, 1
    addiu $t6, $t6, 1
    jr $ra
    nop
    .org 0x80001040
  other:
    addiu $v0, $v0, 7
    jr $ra
    nop`, { t1: 0 }, { t5: 1, t6: 1 }),
  full('likely branch to another function', `
    beql $t1, $t2, other
    addiu $t5, $t5, 1
    jr $ra
    nop
    .org 0x80001040
  other:
    addiu $v0, $v0, 7
    jr $ra
    nop`, { t1: 4, t2: 4 }, { t5: 1, v0: 7 }),
  full('a function without a return continues into the next one', `
    addiu $t0, $t0, 1
    .func
    addiu $t0, $t0, 2
    jr $ra
    nop`, {}, { t0: 3 }),

  ...slotTargets.map(({ name, init, want }) =>
    full(`delay slot as a branch target: ${name}`, `
    bne $t5, $zero, slot
    nop
    beq $t1, $zero, done
  slot:
    addiu $t2, $t2, 1
    addiu $t3, $t3, 10
  done:
    jr $ra
    nop`, init, { ...init, ...want })),
]);

snippetSuite('branch edge cases', [
  snip('branch to the next instruction', 'beq $zero, $zero, next\nnop\nnext:\naddiu $t0, $t0, 1', {}, { t0: 1 }),
  full('zero register never changes in a delay slot', `
    beq $zero, $zero, end
    addiu $zero, $zero, 5
  end:
    jr $ra
    nop`, {}, {}),
]);
