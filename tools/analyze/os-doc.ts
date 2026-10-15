// Renders the per-routine reference of docs/re/os-routines.md from data/os-signatures.json and the addresses found in the ROM.
// Usage: tsx tools/analyze/os-doc.ts [docs/re/os-routines.md]
// Only the text between the begin and end markers is replaced; the rest of the file is hand-written.

import { readFileSync, writeFileSync } from 'node:fs';
import { loadContext, romPathFromEnv } from './context.ts';
import { analyseImage, buildSpecs } from './image.ts';
import { identifyOs, loadSignatures, type OsRoutine } from './os.ts';

export const BEGIN = '<!-- os-routines:begin -->';
export const END = '<!-- os-routines:end -->';

const hex = (n: number) => '0x' + n.toString(16).padStart(8, '0');

const CATEGORY_TITLES: Record<string, string> = {
  boot: 'Boot and start-up', interrupts: 'Interrupt mask, Status and Cause', exceptions: 'Exception handling', threads: 'Threads',
  messages: 'Message queues', events: 'Events', timers: 'Timers and counters', pi: 'PI bus and cartridge access', dma: 'ROM file loading',
  sram: 'Save memory', memory: 'Address translation', tlb: 'TLB', cache: 'Cache', vi: 'Video interface', rsp: 'RSP', rdp: 'RDP', ai: 'Audio interface',
  si: 'Serial interface', eeprom: 'EEPROM', flash: 'FlashRAM', controller: 'Controllers and controller pak', init: 'System initialisation', overlay: 'Overlays',
};

export function renderRoutines(routines: OsRoutine[]): string {
  const cats = new Map<string, OsRoutine[]>();
  for (const r of routines) cats.set(r.category, [...(cats.get(r.category) ?? []), r]);
  const out: string[] = [];
  const order = Object.keys(CATEGORY_TITLES).filter((c) => cats.has(c));
  for (const c of cats.keys()) if (!order.includes(c)) order.push(c);
  for (const c of order) {
    const list = cats.get(c)!;
    const absent = list.filter((r) => r.status === 'not-present');
    const found = list.filter((r) => r.status === 'found').sort((a, b) => (a.addr ?? 0) - (b.addr ?? 0));
    if (found.length === 0 && absent.length === 0) continue;
    out.push(`### ${CATEGORY_TITLES[c] ?? c}`, '');
    for (const r of found) {
      out.push(`#### \`${r.id}\` (${r.image}, ${hex(r.addr!)}–${hex(r.end!)})`, '', r.summary, '', `Evidence: ${r.evidence}`, '');
    }
    for (const r of absent) out.push(`#### \`${r.id}\` — not present`, '', r.summary, '', `Evidence: ${r.evidence}`, '');
  }
  return out.join('\n');
}

export function spliceDoc(doc: string, body: string): string {
  const a = doc.indexOf(BEGIN);
  const b = doc.indexOf(END);
  if (a < 0 || b < a) throw new Error(`markers ${BEGIN} / ${END} not found`);
  return doc.slice(0, a + BEGIN.length) + '\n\n' + body + '\n' + doc.slice(b);
}

if (process.argv[1]?.endsWith('os-doc.ts')) {
  const path = process.argv[2] ?? 'docs/re/os-routines.md';
  const ctx = loadContext(romPathFromEnv());
  const specs = buildSpecs(ctx);
  const { routines } = identifyOs(ctx, specs, specs.map((s) => analyseImage(s)), loadSignatures());
  writeFileSync(path, spliceDoc(readFileSync(path, 'utf8'), renderRoutines(routines)));
  console.log(`wrote ${path}`);
}
