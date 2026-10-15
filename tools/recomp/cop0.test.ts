import { DATA_BASE as D } from './harness.ts';
import { full, snip, snippetSuite } from './suite.ts';

snippetSuite('COP0, TLB and cache instructions', [
  snip('mfc0 reads through the runtime and sign extends', 'mfc0 $t0, $12', {}, { t0: 0xffffffff90000000n }, {
    cop0: { 12: 0x90000000n }, expectCop0: { 12: 0x90000000n },
  }),
  snip('dmfc0 reads the full register', 'dmfc0 $t0, $14', {}, { t0: 0x0123456789abcdefn }, {
    cop0: { 14: 0x0123456789abcdefn }, expectCop0: { 14: 0x0123456789abcdefn },
  }),
  snip('mtc0 writes the low word sign extended', 'mtc0 $t0, $9', { t0: 0x1234567880001234n }, {}, {
    expectCop0: { 9: 0xffffffff80001234n },
  }),
  snip('dmtc0 writes the full register', 'dmtc0 $t0, $10', { t0: 0x1234567880001234n }, {}, {
    expectCop0: { 10: 0x1234567880001234n },
  }),
  snip('mtc0 then mfc0', 'mtc0 $t0, $11\nmfc0 $t1, $11', { t0: 5 }, { t1: 5 }, { expectCop0: { 11: 5 } }),
  snip('TLB instructions are runtime calls', 'tlbr\ntlbwi\ntlbwr\ntlbp', {}, {}, {
    events: ['tlb 1 80001000', 'tlb 2 80001004', 'tlb 3 80001008', 'tlb 4 8000100c'],
  }),
  snip('cache operations carry the operation and the address', 'cache $0, 4($t1)\ncache $25, -16($t1)', { t1: D }, {}, {
    events: ['cache 0 80002004', 'cache 25 80001ff0'],
  }),
  full('eret leaves the function', `
    eret
    addiu $t0, $zero, 1
    jr $ra
    nop`, {}, {}, { trap: { kind: 'eret' } }),
]);
