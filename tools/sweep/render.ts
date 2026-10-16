// Markdown for docs/re/gaps.md: the static tables and the results of the scene sweep.
import { isMmio, registerName } from './mmio.ts';
import type { OpcodeRow, StaticSweep } from './static.ts';
import type { SceneSweepReport } from './scenes.ts';

const hex = (n: number) => `0x${(n >>> 0).toString(16)}`;
const table = (head: string[], rows: string[][]) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');

/** Replaces the text between the marker comments `<!-- name:begin -->` and `<!-- name:end -->`. */
export function replaceBlock(doc: string, name: string, text: string): string {
  const begin = `<!-- ${name}:begin -->`;
  const end = `<!-- ${name}:end -->`;
  const a = doc.indexOf(begin);
  const b = doc.indexOf(end);
  if (a < 0 || b < a) throw new Error(`the document has no ${begin} … ${end} block`);
  return `${doc.slice(0, a + begin.length)}\n${text.trim()}\n${doc.slice(b)}`;
}

function opcodeTable(rows: OpcodeRow[], withHeads: boolean): string {
  const shown = rows.filter((r) => r.handler !== null || r.status !== 'unsupported-by-design' || r.name !== '');
  const main = table(['Op', 'Name', 'Handler', 'Status', 'Why'], shown.map((r) => [
    `\`${r.op.toString(16).padStart(2, '0')}\``, r.name, r.handler === null ? '–' : `\`${hex(r.handler)}\``, r.status, r.reason,
  ]));
  if (!withHeads) return main;
  const heads = rows.filter((r) => r.head.length > 0).map((r) => `- \`${r.op.toString(16).padStart(2, '0')}\` at \`${hex(r.handler!)}\`: \`${r.head.map((l) => l.replace(/^[0-9a-f]+: [0-9a-f]+ +/, '')).join('; ')}\``);
  return `${main}\n\nFirst instructions of the handlers the runtime lacks:\n\n${heads.join('\n')}`;
}

export function renderStatic(s: StaticSweep, scenes?: SceneSweepReport): string {
  const out: string[] = [];
  const covered = scenes?.coverage;
  const fnRan = new Set(covered?.functions ?? []);

  out.push('### RSP tasks\n');
  out.push(`Submitters of tasks to the RSP (callers found in the inventory): ${s.tasks.submitters.map((x) => `\`${x.routine}\` (${hex(x.address)}) called from ${x.callers.map((c) => `\`${hex(c)}\``).join(', ') || 'nowhere'}`).join('; ')}.\n`);
  out.push(table(['Type', 'Source', 'At', 'Microcode', 'Data', 'Used by', 'Runtime', ...(scenes ? ['Seen'] : [])], s.tasks.tasks.map((t) => [
    String(t.type), t.source, `\`${hex(t.address)}\``, t.ucode === null ? 'variable' : `\`${hex(t.ucode)}\` (${hex(t.ucodeSize ?? 0)} bytes)`,
    t.ucodeData === null ? '–' : `\`${hex(t.ucodeData)}\``, t.functions.map((f) => `\`${hex(f)}\``).join(', '), `${t.handled ? 'handled' : '**not handled**'}: ${t.runtime}`,
    ...(scenes ? [scenes.rspTasks.some((k) => k.type === t.type && k.ucode === t.ucode) ? 'yes' : 'no'] : []),
  ])));
  out.push(`\nMicrocode texts that code outside the task builders loads by address (physical or KSEG0 form): ${s.microcodes.map((m) => `\`${hex(m.address)}\` (built in ${m.functions.map((f) => `\`${hex(f)}\``).join(', ')}; starts \`${m.head.map((l) => l.replace(/^[0-9a-f]+: [0-9a-f]+ +/, '')).join('; ')}\`)`).join('; ') || 'none'}.`);
  out.push('\nNotes: ' + s.tasks.tasks.map((t) => `type ${t.type} at \`${hex(t.address)}\`: ${t.note}`).join('; ') + '.\n');
  out.push('Microcode heads (RSP disassembly of the first words): ' + s.tasks.tasks.filter((t) => t.ucodeHead.length > 0).map((t) => `\`${hex(t.ucode!)}\` = \`${t.ucodeHead.map((l) => l.replace(/^[0-9a-f]+: [0-9a-f]+ +/, '')).join('; ')}\``).join('; ') + '.\n');

  out.push('### Graphics microcode opcodes\n');
  out.push(`Microcode text ${hex(s.graphics.ucode)}, data ${hex(s.graphics.data)}. ${s.graphics.signature}.\n`);
  out.push(opcodeTable(s.graphics.table.filter((r) => r.handler !== null || r.name !== ''), true));
  const gfxCounts = countBy(s.graphics.table.map((r) => r.status));
  out.push(`\nOf 256 opcode values: ${Object.entries(gfxCounts).map(([k, v]) => `${v} ${k}`).join(', ')} (the last are the values outside the table).\n`);

  out.push('### Audio microcode opcodes\n');
  out.push(`Microcode text ${hex(s.audio.ucode)}, data ${hex(s.audio.data)}. ${s.audio.signature}.\n`);
  out.push(opcodeTable(s.audio.table, true));
  out.push('');

  out.push('### OS routines\n');
  out.push('`replaced` = the runtime defines `rt_<id>`; `recompiled` = the game\'s own code runs and touches nothing but guest memory; `gap` = recompiled code that reads or writes hardware the runtime does not model.\n');
  const ran = (e: { address: number; disposition: string }) => (covered ? (e.disposition === 'replaced' ? covered.osCalls.some(([a]) => a === e.address) : fnRan.has(e.address)) : undefined);
  out.push(table(['Routine', 'Address', 'Category', 'Disposition', 'Reason', 'Callers', ...(covered ? ['Ran'] : [])], s.os.entries.map((e) => [
    `\`${e.id}\``, `\`${hex(e.address)}\``, e.category, e.disposition === 'gap' ? '**gap**' : e.disposition, e.reason, String(e.callers), ...(covered ? [ran(e) ? 'yes' : 'no'] : []),
  ])));
  out.push(`\nIdentified in the inventory but absent from the binary: ${s.os.absent.map((a) => `\`${a}\``).join(', ')}.\n`);

  out.push('### Hardware register accesses outside the replaced routines\n');
  const sites = s.os.mmio.filter((m) => !m.replaced);
  const byFunction = new Map<number, typeof sites>();
  for (const m of sites) byFunction.set(m.function, [...(byFunction.get(m.function) ?? []), m]);
  out.push(`${s.os.mmio.length} accesses through constant addresses in the MMIO range were found; ${s.os.mmio.length - sites.length} sit inside replaced routines and never run. ${sites.length} sit in ${byFunction.size} functions that run as recompiled (straight-line base registers only unless marked \`across-branch\`, where the base register is carried over a branch):\n`);
  out.push(table(['Function', 'Image', 'Owner', 'Registers', 'Sites', ...(covered ? ['Ran'] : [])], [...byFunction].map(([fn, ms]) => [
    `\`${hex(fn)}\``, ms[0]!.image, ms[0]!.owner ? `\`${ms[0]!.owner}\`` : '–',
    [...new Set(ms.map((m) => m.register))].join(', '), ms.map((m) => `\`${hex(m.at)}\` ${m.op}${m.basis === 'across-branch' ? ' (across-branch)' : ''}`).join(', '),
    ...(covered ? [fnRan.has(fn) ? 'yes' : 'no'] : []),
  ])));
  const special = s.os.special.filter((x) => !x.replaced);
  out.push(`\nCOP0, cache, TLB and exception instructions outside replaced routines: ${special.length} sites in ${new Set(special.map((x) => x.function)).size} functions (${Object.entries(countBy(special.map((x) => x.op.split(' ')[0]!))).map(([k, v]) => `${v} ${k}`).join(', ')}). Of these ${special.filter((x) => x.owner !== null).length} sit in identified OS routines.\n`);

  out.push('### Recompiler\n');
  const r = s.recompiler;
  out.push(`- ${r.functions} functions in ${r.images} images; ${r.jumpTables} jump tables recovered; ${r.indirectCalls} indirect calls (\`jalr\`), none with a statically known target: they dispatch through the runtime's table at run time and trap with \`missing function\` when the target is not recompiled.`);
  out.push(`- \`jr\` that is neither a return nor a recovered jump table: ${r.unresolvedJumps.length === 0 ? 'none' : r.unresolvedJumps.map((j) => `\`${hex(j.at)}\` (${j.image}, in \`${hex(j.function)}\`, \`${j.reg}\`)`).join('; ')}.`);
  out.push(`- Direct calls or jumps to an address that starts no function: ${r.missingTargets.length === 0 ? 'none' : r.missingTargets.map((m) => `\`${hex(m.address)}\` (from ${m.from.map((f) => `\`${hex(f)}\``).join(', ')})`).join('; ')}.`);
  out.push(`- Text bytes no function covers: ${r.uncoveredText.length === 0 ? 'none in any image' : r.uncoveredText.map((u) => `${u.image} ${u.bytes}`).join(', ')}. Images without functions: ${r.imagesWithoutFunctions.map((i) => `\`${i}\``).join(', ') || 'none'} (no text section).`);
  out.push(`- Data words holding a text address that is not a function entry: ${r.pointersIntoCode.jumpTableLabels} are labels of recovered jump tables; ${r.pointersIntoCode.insideFunction.length} point into a function (${r.pointersIntoCode.insideFunction.map((p) => `\`${hex(p.at)}\`→\`${hex(p.target)}\` in \`${hex(p.function)}\` (${p.image})`).join('; ') || 'none'}); ${r.pointersIntoCode.outsideFunctions.length} point at text no function covers (${r.pointersIntoCode.outsideFunctions.map((p) => `\`${hex(p.at)}\`→\`${hex(p.target)}\` (${p.image})`).join('; ') || 'none'}).\n`);

  out.push('### Scene and entrance tables\n');
  const invalid = s.scenes.entrances.filter((e) => !e.valid);
  out.push(`The entrance table has ${s.scenes.entrances.length} entries; the scene table ${s.scenes.sceneRecords} records. ${invalid.length} entries name a scene past the table (${compactRanges(invalid.map((e) => e.index))}); the sweep skips them. ${new Set(s.scenes.entrances.filter((e) => e.valid).map((e) => e.scene)).size} different scenes are named by the valid entries.\n`);
  return out.join('\n');
}

function countBy(items: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[i] = (out[i] ?? 0) + 1;
  return out;
}

function compactRanges(values: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < values.length; ) {
    let j = i;
    while (j + 1 < values.length && values[j + 1] === values[j]! + 1) j++;
    out.push(j > i ? `${values[i]}–${values[j]}` : String(values[i]));
    i = j + 1;
  }
  return out.slice(0, 40).join(', ') + (out.length > 40 ? ', …' : '');
}

export function renderScenes(report: SceneSweepReport, s: StaticSweep): string {
  const out: string[] = [];
  const results = report.results;
  const swept = results.filter((r) => r.status !== 'invalid-scene');
  const by = countBy(results.map((r) => r.status));
  out.push(`Sweep of ${results.length} entrances (${swept.length} run, ${by['invalid-scene'] ?? 0} skipped as invalid), ${report.frames} video frames each, from the game under control at frame ${report.startFrame}; ${report.restarts} game instance(s) started (1 + recoveries).\n`);
  out.push(`Status: ${Object.entries(by).map(([k, v]) => `${v} ${k}`).join(', ')}. Blank: ${Object.entries(countBy(swept.map((r) => r.blank))).map(([k, v]) => `${v} ${k}`).join(', ')}.\n`);

  type Result = (typeof results)[number];
  const group = (pick: (r: Result) => string[]) => {
    const m = new Map<string, Result[]>();
    for (const r of swept) for (const key of pick(r)) m.set(key, [...(m.get(key) ?? []), r]);
    return m;
  };
  const scenesOf = (rs: Result[], pickScene: (r: Result) => number | null = (r) => r.effectiveScene) => {
    const scenes = [...new Set(rs.map(pickScene).filter((x): x is number => x !== null))].sort((a, b) => a - b);
    return `${rs.length} entrance${rs.length === 1 ? '' : 's'}; scenes ${scenes.join(', ')}`;
  };
  const entrancesOf = (rs: Result[]) => compactRanges(rs.map((r) => r.entrance));

  out.push('Traps and hangs (a game that loops past 200 million iterations in one frame is stopped by the watchdog of the coverage build):\n');
  const traps = group((r) => (r.trap ? [r.trap] : []));
  out.push(traps.size === 0 ? 'none.' : table(['Message', 'Hits', 'Entrances'], [...traps].map(([k, v]) => [k, scenesOf(v), entrancesOf(v)])));

  out.push('\nUnknown display-list commands (a `*` marks commands that follow an opcode 0xdd in the same list):\n');
  const unknownGfx = group((r) => Object.keys(r.unknownCommands));
  out.push(unknownGfx.size === 0 ? 'none.' : table(['Opcode', 'Hits', 'First command seen'], [...unknownGfx].sort().map(([k, v]) => [`\`${k}\``, scenesOf(v), `entrance ${v[0]!.entrance}: \`${v[0]!.unknownSamples[k] ?? ''}\``])));

  out.push('\nAudio opcodes the mixer rejects:\n');
  const unknownAudio = group((r) => Object.keys(r.unknownAudio));
  out.push(unknownAudio.size === 0 ? 'none.' : table(['Opcode', 'Hits'], [...unknownAudio].map(([k, v]) => [`\`${k}\``, scenesOf(v)])));

  out.push('\nDisplay-list problems the interpreter worked around:\n');
  const problems = group((r) => r.problems);
  out.push(problems.size === 0 ? 'none.' : table(['Problem', 'Hits'], [...problems].map(([k, v]) => [k, scenesOf(v)])));

  out.push('\nBlank frames:\n');
  const blank = group((r) => (r.blank === 'no' ? [] : [r.blank]));
  out.push(blank.size === 0 ? 'none.' : table(['Kind', 'Hits', 'Entrances'], [...blank].map(([k, v]) => [k, scenesOf(v, (r) => r.reachedScene), entrancesOf(v)])));

  out.push('\nEntrances after which the play state shows another scene than the entry the game loaded (index plus setup variant) names. The game redirects some entries itself, and an entry with a cutscene setup shifts the variant:\n');
  const redirected = swept.filter((r) => r.status === 'not-reached');
  out.push(redirected.length === 0 ? 'none.' : table(['Entrance', 'Table scene', 'Variant', 'Loaded entry', 'Its scene', 'Reached scene'], redirected.map((r) => [
    String(r.entrance), String(r.scene), String(r.variant), String(r.effective), String(r.effectiveScene ?? '–'), String(r.reachedScene ?? '–'),
  ])));

  out.push('\nExecuted RSP tasks: ' + report.rspTasks.map((k) => `type ${k.type} microcode \`${hex(k.ucode)}\` ×${k.count}`).join('; ') + '.\n');
  out.push('Graphics opcodes executed (opcode ×count): ' + Object.entries(report.graphicsOpcodes).sort().map(([k, v]) => `\`${k}\`×${v}`).join(' ') + '.\n');
  const missingGfx = s.graphics.table.filter((r) => r.status !== 'implemented' && (report.graphicsOpcodes[r.op.toString(16).padStart(2, '0')] ?? 0) > 0);
  out.push(`Executed graphics opcodes the interpreter lacks: ${missingGfx.map((r) => `\`${r.op.toString(16)}\``).join(', ') || 'none'}.\n`);
  out.push('Audio opcodes executed (opcode ×count): ' + Object.entries(report.audioOpcodes).sort().map(([k, v]) => `\`${k}\`×${v}`).join(' ') + '.\n');
  const audioMissing = s.audio.table.filter((r) => r.status === 'missing').map((r) => r.op);
  const audioNever = s.audio.table.filter((r) => r.status === 'implemented' && !(r.op.toString(16).padStart(2, '0') in report.audioOpcodes)).map((r) => `\`${r.op.toString(16)}\``);
  out.push(`Audio opcodes the mixer lacks: ${audioMissing.map((o) => `\`${o.toString(16)}\``).join(', ')}; of the implemented ones, never executed: ${audioNever.join(', ') || 'none'}.\n`);

  if (report.coverage) {
    const c = report.coverage;
    const ran = new Set(c.functions);
    const perImage = s.functionsByImage.map((i) => ({ ...i, ran: i.starts.filter((a) => ran.has(a)).length }));
    const of = (kind: string) => perImage.filter((i) => i.kind === kind);
    const sum = (items: typeof perImage, pick: (i: (typeof perImage)[number]) => number) => items.reduce((n, i) => n + pick(i), 0);
    const overlays = of('overlay').filter((i) => i.starts.length > 0);
    const untouched = overlays.filter((i) => i.ran === 0);
    out.push(`Coverage: ${c.functions.length} of ${s.recompiler.functions} recompiled functions ran (boot ${sum(of('boot'), (i) => i.ran)} of ${sum(of('boot'), (i) => i.starts.length)}, main code ${sum(of('code'), (i) => i.ran)} of ${sum(of('code'), (i) => i.starts.length)}, overlays ${sum(overlays, (i) => i.ran)} of ${sum(overlays, (i) => i.starts.length)}); ${overlays.length - untouched.length} of ${overlays.length} overlays with code had a function run; ${c.osCalls.length} of ${s.os.entries.filter((e) => e.disposition === 'replaced').length} replaced OS routines were called (calls made through the dispatch table are not counted). Overlays no function of which ran: ${untouched.map((i) => `\`${i.image}\``).join(', ') || 'none'}.\n`);
    const device = c.outsideRdram.filter((o) => isMmio(o.addr));
    const others = c.outsideRdram.filter((o) => !isMmio(o.addr));
    const scenesAt = (addr: number) => {
      const hit = swept.filter((r) => r.outsideRdram.some((o) => o.addr === addr));
      return hit.length === 0 ? 'the scripted start (boot, title, file select, opening)' : scenesOf(hit);
    };
    out.push(`Accesses beyond RDRAM, in 256-byte blocks (the first address touched; the function entered last when it was first touched is only a hint):\n`);
    out.push('Hardware registers and cartridge space (the replaced routines never reach the hardware, so each of these is recompiled code touching a device):\n');
    out.push(device.length === 0 ? 'none.' : table(['Address', 'Register', 'Accesses', 'Function entered last', 'Seen in'], device.map((o) => [`\`${hex(o.addr)}\``, registerName(o.addr & 0x1fffffff), String(o.hits), `\`${hex(o.function)}\``, scenesAt(o.addr)])));
    out.push('\nOther addresses (not a device: a wild pointer, or a read past the end of RDRAM):\n');
    out.push(others.length === 0 ? 'none.' : table(['Address', 'Kind', 'Accesses', 'Function entered last', 'Seen in'], others.map((o) => [`\`${hex(o.addr)}\``, o.addr >>> 0 >= 0x80800000 && o.addr >>> 0 < 0xa0000000 ? 'just past the 8 MiB of RDRAM' : (o.addr >>> 0) < 0x80000000 ? 'user segment (unmapped)' : 'other', String(o.hits), `\`${hex(o.function)}\``, scenesAt(o.addr)])));
  }
  return out.join('\n');
}
