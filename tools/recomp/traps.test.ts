import type { Snippet } from './harness.ts';
import { full, snip, snippetSuite } from './suite.ts';

const NEG = 0xffffffffffffffffn;
const PC = 0x80001000;

const cond = (insn: string, init: Snippet['regs'], trap: boolean) =>
  snip(`${insn} ${trap ? 'traps' : 'does not trap'}`, `${insn}\naddiu $t0, $t0, 1`, init, trap ? {} : { t0: 1 },
    trap ? { trap: { kind: 'cond', pc: PC, code: 0 } } : {});

snippetSuite('traps and exceptions', [
  snip('break', 'break', {}, {}, { trap: { kind: 'break', pc: PC, code: 0 } }),
  snip('break with a code', 'break 7', {}, {}, { trap: { kind: 'break', pc: PC, code: 7 } }),
  snip('break with the largest code', 'break 0xfffff', {}, {}, { trap: { kind: 'break', code: 0xfffff } }),
  snip('syscall with a code', 'syscall 0x123', {}, {}, { trap: { kind: 'syscall', pc: PC, code: 0x123 } }),
  snip('sync does nothing', 'sync\naddiu $t0, $t0, 1', {}, { t0: 1 }),
  snip('nothing runs after a trap', 'break 1\naddiu $t0, $t0, 1', {}, {}, { trap: { kind: 'break', code: 1 } }),
  full('a trap in a delay slot reports the slot address', `
    beq $zero, $zero, end
    break 3
  end:
    jr $ra
    nop`, {}, {}, { trap: { kind: 'break', pc: PC + 4, code: 3 } }),
  full('a trapping branch does not branch', `
    beq $zero, $zero, end
    break 3
    nop
  end:
    addiu $t0, $t0, 1
    jr $ra
    nop`, {}, {}, { trap: { kind: 'break' } }),

  cond('tge $t1, $t2', { t1: 2, t2: 1 }, true),
  cond('tge $t1, $t2', { t1: 1, t2: 1 }, true),
  cond('tge $t1, $t2', { t1: -1, t2: 1 }, false),
  cond('tgeu $t1, $t2', { t1: -1, t2: 1 }, true),
  cond('tgeu $t1, $t2', { t1: 1, t2: 2 }, false),
  cond('tlt $t1, $t2', { t1: -1, t2: 1 }, true),
  cond('tlt $t1, $t2', { t1: 1, t2: -1 }, false),
  cond('tltu $t1, $t2', { t1: 1, t2: 2 }, true),
  cond('tltu $t1, $t2', { t1: -1, t2: 1 }, false),
  cond('teq $t1, $t2', { t1: 5, t2: 5 }, true),
  cond('teq $t1, $t2', { t1: 5, t2: 6 }, false),
  cond('teq $t1, $t2', { t1: 0x100000005n, t2: 5 }, false),
  cond('tne $t1, $t2', { t1: 5, t2: 6 }, true),
  cond('tne $t1, $t2', { t1: 5, t2: 5 }, false),

  cond('tgei $t1, -2', { t1: -1 }, true),
  cond('tgei $t1, -2', { t1: -3 }, false),
  cond('tgeiu $t1, -1', { t1: NEG }, true),
  cond('tgeiu $t1, -1', { t1: 5 }, false),
  cond('tlti $t1, -1', { t1: -2 }, true),
  cond('tlti $t1, -1', { t1: 0 }, false),
  cond('tltiu $t1, -1', { t1: 5 }, true),
  cond('tltiu $t1, -1', { t1: NEG }, false),
  cond('teqi $t1, -1', { t1: NEG }, true),
  cond('teqi $t1, -1', { t1: 0xffff }, false),
  cond('tnei $t1, 5', { t1: 6 }, true),
  cond('tnei $t1, 5', { t1: 5 }, false),

  full('an undefined instruction is reported, not skipped', `
    .word 0xec000000
    jr $ra
    nop`, {}, {}, { trap: { kind: 'unimplemented', pc: PC, code: 0xec000000 } }),
  full('a coprocessor 2 instruction is reported', `
    .word 0x48000000
    jr $ra
    nop`, {}, {}, { trap: { kind: 'unimplemented', pc: PC, code: 0x48000000 } }),
]);
