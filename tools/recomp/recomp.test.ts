import { describe, expect, it } from 'vitest';
import { decode } from '../analyze/mips.ts';
import { assemble, INTEGER_MNEMONICS } from './asm.ts';
import { recompileFunction, recompileUnit } from './emit.ts';

const asm1 = (line: string) => assemble(line, 0x80001000).funcs[0]!.words[0]!;
const hex = (n: number) => '0x' + (n >>> 0).toString(16).padStart(8, '0');

describe('assembler', () => {
  // Encodings written out by hand from the instruction formats.
  const known: [string, number][] = [
    ['jr $ra', 0x03e00008],
    ['addiu $sp, $sp, -24', 0x27bdffe8],
    ['lui $t0, 0x8000', 0x3c088000],
    ['sw $ra, 20($sp)', 0xafbf0014],
    ['lw $t0, 0($a0)', 0x8c880000],
    ['sll $t0, $t1, 4', 0x00094100],
    ['nop', 0],
    ['jal 0x80001000', 0x0c000400],
    ['b 0x80001000', 0x1000ffff],
    ['addu $v0, $a0, $a1', 0x00851021],
    ['dsll32 $t0, $t1, 31', 0x000947fc],
    ['bgezal $zero, 0x80001008', 0x04110001],
    ['jalr $t9', 0x0320f809],
  ];
  for (const [text, word] of known) {
    it(`encodes ${text}`, () => expect(hex(asm1(text))).toBe(hex(word)));
  }

  const R3 = new Set(['add', 'addu', 'sub', 'subu', 'and', 'or', 'xor', 'nor', 'slt', 'sltu', 'dadd', 'daddu', 'dsub', 'dsubu']);
  const IMM = new Set(['addi', 'addiu', 'slti', 'sltiu', 'daddi', 'daddiu', 'andi', 'ori', 'xori']);
  const SHIFT = new Set(['sll', 'srl', 'sra', 'dsll', 'dsrl', 'dsra', 'dsll32', 'dsrl32', 'dsra32']);
  const VSHIFT = new Set(['sllv', 'srlv', 'srav', 'dsllv', 'dsrlv', 'dsrav']);
  const RS_RT = new Set(['mult', 'multu', 'div', 'divu', 'dmult', 'dmultu', 'ddiv', 'ddivu', 'tge', 'tgeu', 'tlt', 'tltu', 'teq', 'tne']);
  const RS_IMM = new Set(['tgei', 'tgeiu', 'tlti', 'tltiu', 'teqi', 'tnei']);
  const ONE_REG = new Set(['jr', 'mfhi', 'mthi', 'mflo', 'mtlo']);
  const operands = (name: string): string => {
    if (R3.has(name)) return '$t0, $t1, $t2';
    if (IMM.has(name)) return '$t0, $t1, 12';
    if (SHIFT.has(name)) return '$t0, $t1, 3';
    if (VSHIFT.has(name)) return '$t0, $t1, $t2';
    if (RS_RT.has(name)) return '$t0, $t1';
    if (RS_IMM.has(name)) return '$t0, 4';
    if (ONE_REG.has(name)) return '$t0';
    if (name === 'jalr') return '$t1, $t0';
    if (name === 'syscall' || name === 'break') return '5';
    if (name === 'sync') return '';
    if (name === 'j' || name === 'jal') return '0x80001010';
    if (name === 'lui') return '$t0, 0x1234';
    if (name === 'beq' || name === 'bne' || name === 'beql' || name === 'bnel') return '$t0, $t1, 0x80001010';
    if (name.startsWith('b')) return '$t0, 0x80001010';
    return '$t0, 12($t1)';
  };
  for (const name of INTEGER_MNEMONICS) {
    it(`${name} disassembles back to itself`, () => {
      expect(decode(asm1(`${name} ${operands(name)}`), 0x80001000).op).toBe(name);
    });
  }

  it('resolves labels forward and backward', () => {
    const { funcs, labels } = assemble('top:\nbeq $t0, $t1, end\nnop\nb top\nnop\nend:\nnop', 0x80001000);
    expect(labels.get('end')).toBe(0x80001010);
    expect(hex(funcs[0]!.words[0]!)).toBe(hex(0x11090003));
    expect(hex(funcs[0]!.words[2]!)).toBe(hex(0x1000fffd));
  });

  it('splits functions at .func and .org', () => {
    const { funcs } = assemble('nop\n.func\nnop\nnop\n.org 0x80001100\nnop', 0x80001000);
    expect(funcs.map((f) => [f.addr, f.words.length])).toEqual([[0x80001000, 1], [0x80001004, 2], [0x80001100, 1]]);
  });

  it('rejects bad input', () => {
    expect(() => asm1('frobnicate $t0')).toThrow(/unknown instruction/);
    expect(() => asm1('addiu $t0, $t1, 40000')).toThrow(/out of range/);
    expect(() => asm1('dsll $t0, $t1, 32')).toThrow(/shift/);
    expect(() => asm1('addu $t0, $t1')).toThrow(/operands/);
    expect(() => asm1('addu $t0, $t1, $bogus')).toThrow(/register/);
  });
});

describe('recompiler', () => {
  const recompile = (src: string) => recompileFunction(assemble(src, 0x80001000).funcs[0]!);

  it('rejects a branch in a delay slot', () => {
    expect(() => recompile('beq $t0, $t1, 0x80001000\nbeq $t0, $t1, 0x80001000\nnop')).toThrow(/delay slot/);
  });

  it('rejects a branch without a delay slot', () => {
    expect(() => recompile('nop\njr $ra')).toThrow(/without a delay slot/);
  });

  it('names functions by address and lists callees', () => {
    const r = recompile('jal 0x80002000\nnop\nj 0x80003000\nnop');
    expect(r.name).toBe('fn_80001000');
    expect(r.callees).toEqual([0x80002000, 0x80003000]);
  });

  it('declares every callee in a unit', () => {
    const unit = recompileUnit(assemble('jal 0x80002000\nnop\njr $ra\nnop', 0x80001000).funcs);
    expect(unit).toContain('void fn_80002000(Cpu *c);');
    expect(unit).toContain('void fn_80001000(Cpu *c) {');
  });

  it('only emits labels for jump targets', () => {
    const code = recompile('nop\nbeq $t0, $t1, end\nnop\nnop\nend:\njr $ra\nnop').code;
    expect(code).toContain('goto L_80001010;');
    expect(code).toContain('L_80001010:;');
    expect(code).not.toContain('L_80001000:');
  });

  it('never writes $zero', () => {
    const code = recompile('addu $zero, $t0, $t1\njr $ra\nnop').code;
    expect(code).not.toContain('c->r[0] =');
  });
});
