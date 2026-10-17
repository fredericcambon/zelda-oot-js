// Recompiles every function of the inventory into C: one file per image, a shared header, a dispatch
// table per image and the weak bindings through which the runtime replaces the OS routines.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RomContext } from '../analyze/context.ts';
import { buildSpecs, type ImageSpec } from '../analyze/image.ts';
import { decode } from '../analyze/mips.ts';
import type { Inventory, InvImage } from '../analyze/types.ts';
import { defaultSymbol, recompileFunction, type FuncInput } from './emit.ts';

export interface GenerateResult {
  files: string[];
  functions: number;
  /** Call sites of the recompiled functions: the entries of oot_sites. */
  callSites: number;
  osBindings: number;
  /** Anything that stops the output from being a faithful translation; empty on success. */
  problems: string[];
}

const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
const safeName = (s: string) => s.replace(/\W/g, '_');

/** One entry of oot_sites. */
interface SiteRow {
  key: number;
  /** Entry address of the function that contains the site. */
  entry: number;
  addr: number;
}

/** The sites of one image: they take consecutive keys. */
interface ImageSites {
  first: number;
  rows: SiteRow[];
}

/**
 * The OS routines of the runtime that can take the processor from the thread that calls them, and so leave its call
 * chain parked on a fiber: the blocking routines of runtime/sched.c (`blocking_routine`) and the loader that runs
 * recompiled code. A call that cannot reach one of them, or a call through the dispatch tables, needs no frame on
 * the shadow stack.
 */
export const SUSPENDING_ROUTINES: readonly string[] = [
  'osRecvMesg', 'osSendMesg', 'osJamMesg', 'osYieldThread', 'osStopThread', 'osStartThread', 'osSetThreadPri',
  'osGetCount', 'osGetTime', 'osAiGetLength', 'osViGetCurrentFramebuffer', 'osContInit', 'osContStartReadData', 'osContStartQuery',
  'overlay_load',
];

interface OsRoutine {
  id: string;
  status: string;
  addr: number | null;
}

export function generate(ctx: RomContext, inv: Inventory, outDir: string): GenerateResult {
  const specs = new Map<string, ImageSpec>(buildSpecs(ctx).map((s) => [s.name, s]));
  const problems: string[] = [];
  const osNames = new Map<number, string>();
  const suspendingRoutines = new Set<number>();
  for (const r of (inv.os as { routines: OsRoutine[] }).routines) {
    if (r.status !== 'found' || r.addr === null) continue;
    osNames.set(r.addr, `rt_${safeName(r.id)}`);
    if (SUSPENDING_ROUTINES.includes(r.id)) suspendingRoutines.add(r.addr);
  }
  const starts = new Set<number>();
  for (const img of inv.images) for (const f of img.functions) starts.add(f.start);

  mkdirSync(outDir, { recursive: true });
  const files: string[] = [];
  // Unchanged files keep their modification time so that the C compiler can skip them.
  const emit = (name: string, text: string) => {
    const path = join(outDir, name);
    if (!existsSync(path) || readFileSync(path, 'utf8') !== text) writeFileSync(path, text);
    files.push(name);
  };

  const callee = (a: number) => osNames.get(a) ?? defaultSymbol(a);
  let functions = 0;
  const sources: string[] = [];
  const sites: ImageSites[] = [];
  for (;;) {
    problems.length = 0;
    sources.length = 0;
    sites.length = 0;
    functions = 0;
    let nextKey = 0;
    const suspending = suspendingFunctions(inv, specs, callee, suspendingRoutines);
    // A call to a function that is not a recompiled one (a stub for an unknown address) ends the run.
    const frameless = (a: number) => !suspending.has(a);
    inv.images.forEach((img, index) => {
      const spec = specs.get(img.name);
      if (!spec) throw new Error(`no ROM bytes for image ${img.name}`);
      functions += img.functions.length;
      const own: ImageSites = { first: nextKey, rows: [] };
      sources.push(imageSource(img, spec, index, callee, frameless, starts, problems, own));
      nextKey += own.rows.length;
      sites.push(own);
    });
    const targets = new Set(problems.flatMap((p) => NOT_A_FUNCTION.exec(p)?.[1] ?? []).map((h) => parseInt(h, 16)));
    if (!addEntryFragments(inv, starts, targets)) break;
  }
  inv.images.forEach((img, k) => emit(`${img.name}.c`, sources[k]!));

  const rows = sites.flatMap((im) => im.rows);
  emit('sites.c', [
    '// The call sites of the recompiled functions, by key: the function that holds each, its entry address and the address of the call.',
    '// The shadow stack of a thread holds keys; the runtime turns them into build-independent frames and back (runtime/sched.c).',
    '#define OOT_NO_COV', '#include "oot_gen.h"', '',
    'const SiteEntry oot_sites[] = {', ...rows.map((r) => `  { ${defaultSymbol(r.entry)}, 0x${hex(r.entry)}u, 0x${hex(r.addr)}u },`), '};',
    `const uint32_t oot_site_count = ${rows.length};`, '',
  ].join('\n'));

  const bound = [...osNames.entries()].sort((a, b) => a[0] - b[0]).filter(([a]) => starts.has(a));
  emit('os_bindings.c', [
    '// Default bodies of the OS routines: the recompiled original. A runtime that implements a routine defines',
    '// the same symbol and takes precedence.',
    '#define OOT_NO_COV', '#include "oot_gen.h"', '',
    ...bound.map(([a, n]) => `__attribute__((weak)) void ${n}(Cpu *c) { ${defaultSymbol(a)}(c); }`), '',
  ].join('\n'));
  for (const [a, n] of osNames) if (!starts.has(a)) problems.push(`OS routine ${n} at ${hex(a)} is not a function of the inventory`);
  // Without these, calls that can park a thread would be taken for calls that cannot.
  const known = new Set(osNames.values());
  for (const id of SUSPENDING_ROUTINES) if (!known.has(`rt_${safeName(id)}`)) problems.push(`the suspending OS routine ${id} is not in the inventory`);

  const missing = new Set<number>();
  for (const p of problems.splice(0)) {
    const m = NOT_A_FUNCTION.exec(p);
    if (m) missing.add(parseInt(m[1]!, 16));
    else problems.push(p);
  }
  emit('missing.c', [
    '// Targets of direct transfers that lie in no recompiled image: the runtime reports them if they are ever reached.',
    '#include "oot_gen.h"', '',
    ...[...missing].sort((a, b) => a - b).map((a) => `void ${defaultSymbol(a)}(Cpu *c) { rt_missing(c, 0x${hex(a)}u); }`), '',
  ].join('\n'));

  const decls = new Set<string>();
  for (const a of missing) decls.add(`void ${defaultSymbol(a)}(Cpu *c);`);
  for (const img of inv.images) for (const f of img.functions) decls.add(`void ${defaultSymbol(f.start)}(Cpu *c);`);
  for (const [, n] of bound) decls.add(`void ${n}(Cpu *c);`);
  emit('oot_gen.h', [
    '#ifndef OOT_GEN_H', '#define OOT_GEN_H', '#include "dispatch.h"', '',
    ...inv.images.flatMap((img, k) => (img.kind === 'overlay' ? [`#define ${img.name}_delta (oot_images[${k}].delta)`] : [])),
    '', ...[...decls].sort(), '',
    '// Coverage builds count every call of an OS routine (runtime/cov.c).',
    '#if defined(OOT_COVERAGE) && !defined(OOT_NO_COV)', 'void rt_cov_os(uint32_t index);',
    ...bound.map(([, n], k) => `#define ${n}(c) (rt_cov_os(${k}), ${n}(c))`),
    '#endif', '', '#endif', '',
  ].join('\n'));
  emit('os_cov.c', [
    '// The OS routines of the coverage counters, in the order of the macros of oot_gen.h.',
    '#include <stdint.h>', '',
    `const uint32_t oot_os_cov_count = ${bound.length};`,
    'const uint32_t oot_os_cov_addr[] = {', ...bound.map(([a]) => `  0x${hex(a)}u,`), '};', '',
  ].join('\n'));

  const reg: string[] = ['#include "oot_gen.h"', ''];
  inv.images.forEach((_, k) => reg.push(`extern const DispatchEntry oot_dispatch_${k}[];`, `extern const uint32_t oot_dispatch_${k}_count;`));
  reg.push('', 'ImageInfo oot_images[] = {');
  inv.images.forEach((img, k) => {
    const { start, end } = imageExtent(img);
    const overlay = img.kind === 'overlay';
    reg.push(`  { "${img.name}", 0x${hex(start)}u, 0x${hex(end)}u, ${overlay ? 1 : 0}, 0, ${overlay ? 0 : 1}, oot_dispatch_${k}, 0, ${sites[k]!.first}, ${sites[k]!.rows.length} },`);
  });
  reg.push('};', `const uint32_t oot_image_count = ${inv.images.length};`, '');
  reg.push('// The table sizes are defined next to the tables.');
  reg.push('static void __attribute__((constructor)) oot_fill_counts(void) {');
  inv.images.forEach((_, k) => reg.push(`  oot_images[${k}].count = oot_dispatch_${k}_count;`));
  reg.push('}', '');
  emit('images.c', reg.join('\n'));
  for (const stale of readdirSync(outDir)) if (!files.includes(stale)) rmSync(join(outDir, stale), { force: true });
  return { files, functions, callSites: rows.length, osBindings: bound.length, problems };
}

const NOT_A_FUNCTION = /transfers to ([0-9a-f]{8}), which is not a function$/;

/**
 * A branch or jump may enter another routine in the middle (code shared by two routines). The target gets a
 * function of its own that runs from there to the end of the routine that contains it.
 */
function addEntryFragments(inv: Inventory, starts: Set<number>, targets: Set<number>): boolean {
  let grew = false;
  for (const t of targets) {
    for (const img of inv.images) {
      const owner = img.functions.find((f) => f.start < t && t < f.end);
      if (!owner) continue;
      img.functions.push({ ...owner, start: t, name: null, sources: ['fragment'], evidence: [`entered at ${hex(t)} from another routine`], calls: [] });
      starts.add(t);
      grew = true;
      break;
    }
  }
  return grew;
}

function imageExtent(img: InvImage): { start: number; end: number } {
  const secs = img.sections.filter((s) => s.kind !== 'bss');
  return { start: Math.min(...secs.map((s) => s.start)), end: Math.max(...secs.map((s) => s.end)) };
}

/** The inputs of the recompiler for each function of an image, and the options that all of them share. */
function imageFunctions(img: InvImage, spec: ImageSpec) {
  const dv = new DataView(spec.bytes.buffer, spec.bytes.byteOffset, spec.bytes.byteLength);
  const relocs = new Map<number, number>();
  for (const r of img.relocations) if (r.section === 'text') relocs.set(r.addr, r.type);
  const jumpTables = new Map<number, number[]>();
  for (const j of img.jumpTables) jumpTables.set(j.site, j.targets);
  const functions = img.functions.map((f) => {
    const words: number[] = [];
    for (let a = f.start; a < f.end; a += 4) words.push(dv.getUint32(a - spec.base));
    // A trailing branch brings its delay slot, which lies just past the function's last instruction.
    if (decode(words[words.length - 1]!, f.end - 4).kind !== 'plain' && f.end - spec.base + 4 <= spec.bytes.length) {
      words.push(dv.getUint32(f.end - spec.base));
    }
    return { start: f.start, input: { addr: f.start, words } as FuncInput };
  });
  return { functions, relocs, jumpTables, delta: img.kind === 'overlay' ? `${img.name}_delta` : undefined };
}

/**
 * The entry addresses of the functions that can suspend the thread that runs them: those that call through the dispatch
 * tables, call a suspending OS routine, or call a function that can suspend. Everything else runs to its end once it is entered.
 */
function suspendingFunctions(
  inv: Inventory, specs: Map<string, ImageSpec>, callee: (a: number) => string, suspendingRoutines: Set<number>,
): Set<number> {
  const callers = new Map<number, number[]>();
  const suspending = new Set<number>();
  const work: number[] = [];
  const mark = (a: number) => {
    if (suspending.has(a)) return;
    suspending.add(a);
    work.push(a);
  };
  for (const a of suspendingRoutines) mark(a);
  for (const img of inv.images) {
    const { functions, relocs, jumpTables, delta } = imageFunctions(img, specs.get(img.name)!);
    for (const f of functions) {
      try {
        const r = recompileFunction(f.input, { callee, relocs, jumpTables, delta });
        if (r.indirect) mark(f.start);
        for (const c of r.callees) {
          const list = callers.get(c);
          if (list) list.push(f.start);
          else callers.set(c, [f.start]);
        }
      } catch {
        // Reported when the image is generated.
      }
    }
  }
  while (work.length > 0) for (const caller of callers.get(work.pop()!) ?? []) mark(caller);
  return suspending;
}

function imageSource(
  img: InvImage, spec: ImageSpec, index: number, callee: (a: number) => string, frameless: (a: number) => boolean,
  starts: Set<number>, problems: string[], sites: ImageSites,
): string {
  const { functions, relocs, jumpTables, delta } = imageFunctions(img, spec);
  const out: string[] = ['#include "oot_gen.h"', ''];
  const entries: [number, string][] = [];
  for (const { start, input } of functions) {
    try {
      const r = recompileFunction(input, { callee, relocs, jumpTables, delta, frameless, siteBase: sites.first + sites.rows.length });
      sites.rows.push(...r.sites.map((site) => ({ key: site.key, entry: start, addr: site.addr })));
      if (r.code.includes('rt_unimpl')) problems.push(`${img.name} ${hex(start)}: instruction the recompiler does not translate`);
      for (const c of r.callees) {
        if (!starts.has(c)) problems.push(`${img.name} ${hex(start)}: transfers to ${hex(c)}, which is not a function`);
      }
      out.push(r.code);
      entries.push([start, callee(start)]);
    } catch (e) {
      problems.push(`${img.name} ${hex(start)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  entries.sort((a, b) => a[0] - b[0]);
  out.push(`const DispatchEntry oot_dispatch_${index}[] = {`, ...entries.map(([a, n]) => `  { 0x${hex(a)}u, ${n} },`), '};');
  out.push(`const uint32_t oot_dispatch_${index}_count = ${entries.length};`, '');
  return out.join('\n');
}
