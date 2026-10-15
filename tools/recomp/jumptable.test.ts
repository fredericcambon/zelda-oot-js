import { DATA_BASE as D, dwords, words } from './harness.ts';
import type { Snippet } from './harness.ts';
import { full, snippetSuite } from './suite.ts';

const ENTRY = 0x80001000;
// The jump at `site` is followed by its delay slot, then three cases of three instructions each.
const CASE = (k: number) => ENTRY + 8 + 12 * k;

const TABLE = `
  site:
    jr $t1
    addiu $t5, $t5, 1
  case0:
    addiu $t7, $zero, 10
    jr $ra
    nop
  case1:
    addiu $t7, $zero, 11
    jr $ra
    nop
  case2:
    addiu $t7, $zero, 12
    jr $ra
    nop`;

function dispatch(name: string, target: number, want: bigint | undefined, extra: Partial<Snippet> = {}): Snippet {
  return full(name, TABLE, { t1: target }, want === undefined ? { t5: 1 } : { t5: 1, t7: want }, {
    jumpTables: [{ site: 'site', targets: ['case0', 'case1', 'case2'] }], ...extra,
  });
}

snippetSuite('jump tables', [
  dispatch('first case', CASE(0), 10n),
  dispatch('middle case', CASE(1), 11n),
  dispatch('last case', CASE(2), 12n),
  full('a repeated target', `
  site:
    jr $t1
    nop
  a:
    addiu $t7, $zero, 1
    jr $ra
    nop`, { t1: ENTRY + 8 }, { t7: 1 }, { jumpTables: [{ site: 'site', targets: ['a', 'a', 'a'] }] }),
  full('a target in another function is a tail call', `
  site:
    jr $t1
    nop
    .func
    addiu $t7, $zero, 3
    jr $ra
    nop`, { t1: ENTRY + 8 }, { t7: 3 }, { jumpTables: [{ site: 'site', targets: [String(ENTRY + 8)] }] }),
  dispatch('an address outside the table goes through the dispatch lookup', ENTRY + 0x100, 99n, {
    asm: `${TABLE}
    .org ${ENTRY + 0x100}
    addiu $t7, $zero, 99
    jr $ra
    nop`,
  }),
]);

// Overlay code is recompiled against its link address; the load address differs by `delta`.
const DELTA = 0x100;
const LINK = D;

snippetSuite('relocated overlay code', [
  full('a hi/lo pair resolves to the loaded copy', `
  hi:
    lui $t0, 0x8000
  lo:
    addiu $t0, $t0, 0x2000
    jr $ra
    nop`, {}, { t0: 0xffffffff80000000n + BigInt(LINK & 0xffff) + BigInt(DELTA) }, { relocs: { hi: 5, lo: 6 }, delta: DELTA }),
  full('a hi/lo pair with ori', `
  hi:
    lui $t0, 0x8000
  lo:
    ori $t0, $t0, 0x2000
    jr $ra
    nop`, {}, { t0: 0xffffffff80002100n }, { relocs: { hi: 5, lo: 6 }, delta: DELTA }),
  full('a relocated load reads the loaded data', `
  hi:
    lui $t0, 0x8000
  lo:
    lw $t1, 0x2000($t0)
    jr $ra
    nop`, {}, { t0: 0xffffffff80000000n, t1: 0x22222222 }, {
    relocs: { hi: 5, lo: 6 }, delta: DELTA, mem: [words(LINK, 0x11111111), words(LINK + DELTA, 0x22222222)],
  }),
  full('a relocated store writes the loaded data', `
  hi:
    lui $t0, 0x8000
  lo:
    sw $t1, 0x2000($t0)
    jr $ra
    nop`, { t1: 0x5a5a5a5a }, { t0: 0xffffffff80000000n }, {
    relocs: { hi: 5, lo: 6 }, delta: DELTA, expectMem: [words(LINK + DELTA, 0x5a5a5a5a)],
  }),
  full('a relocated doubleword load', `
  hi:
    lui $t0, 0x8000
  lo:
    ld $t1, 0x2000($t0)
    jr $ra
    nop`, {}, { t0: 0xffffffff80000000n, t1: 0x0102030405060708n }, {
    relocs: { hi: 5, lo: 6 }, delta: DELTA, mem: [dwords(LINK + DELTA, 0x0102030405060708n)],
  }),
  full('words that are not relocated keep their link address', `
    lui $t0, 0x8000
    lw $t1, 0x2000($t0)
    jr $ra
    nop`, {}, { t0: 0xffffffff80000000n, t1: 0x11111111 }, {
    delta: DELTA, mem: [words(LINK, 0x11111111), words(LINK + DELTA, 0x22222222)],
  }),
  full('a jump table holds loaded addresses', `
  site:
    jr $t1
    nop
  case0:
    addiu $t7, $zero, 5
    jr $ra
    nop
  case1:
    addiu $t7, $zero, 6
    jr $ra
    nop`, { t1: ENTRY + 0x14 + DELTA }, { t7: 6 }, {
    delta: DELTA, jumpTables: [{ site: 'site', targets: ['case0', 'case1'] }],
  }),
]);
