// Recompiles every function of the inventory into C: one file per image, a shared header, a dispatch
// table per image and the weak bindings through which the runtime replaces the OS routines.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RomContext } from '../analyze/context.ts';
import { buildSpecs, type ImageSpec } from '../analyze/image.ts';
import { decode } from '../analyze/mips.ts';
import type { Inventory, InvImage } from '../analyze/types.ts';
import { defaultSymbol, recompileFunction } from './emit.ts';

export interface GenerateResult {
  files: string[];
  functions: number;
  osBindings: number;
  /** Anything that stops the output from being a faithful translation; empty on success. */
  problems: string[];
}

const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
const safeName = (s: string) => s.replace(/\W/g, '_');

interface OsRoutine {
  id: string;
  status: string;
  addr: number | null;
}

export function generate(ctx: RomContext, inv: Inventory, outDir: string): GenerateResult {
  const specs = new Map<string, ImageSpec>(buildSpecs(ctx).map((s) => [s.name, s]));
  const problems: string[] = [];
  const osNames = new Map<number, string>();
  for (const r of (inv.os as { routines: OsRoutine[] }).routines) {
    if (r.status === 'found' && r.addr !== null) osNames.set(r.addr, `rt_${safeName(r.id)}`);
  }
  const starts = new Set<number>();
  for (const img of inv.images) for (const f of img.functions) starts.add(f.start);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const files: string[] = [];
  const emit = (name: string, text: string) => {
    writeFileSync(join(outDir, name), text);
    files.push(name);
  };

  const callee = (a: number) => osNames.get(a) ?? defaultSymbol(a);
  let functions = 0;
  const sources: string[] = [];
  for (;;) {
    problems.length = 0;
    sources.length = 0;
    functions = 0;
    inv.images.forEach((img, index) => {
      const spec = specs.get(img.name);
      if (!spec) throw new Error(`no ROM bytes for image ${img.name}`);
      functions += img.functions.length;
      sources.push(imageSource(img, spec, index, callee, starts, problems));
    });
    const targets = new Set(problems.flatMap((p) => NOT_A_FUNCTION.exec(p)?.[1] ?? []).map((h) => parseInt(h, 16)));
    if (!addEntryFragments(inv, starts, targets)) break;
  }
  inv.images.forEach((img, k) => emit(`${img.name}.c`, sources[k]!));

  const bound = [...osNames.entries()].sort((a, b) => a[0] - b[0]).filter(([a]) => starts.has(a));
  emit('os_bindings.c', [
    '// Default bodies of the OS routines: the recompiled original. A runtime that implements a routine defines',
    '// the same symbol and takes precedence.',
    '#include "oot_gen.h"', '',
    ...bound.map(([a, n]) => `__attribute__((weak)) void ${n}(Cpu *c) { ${defaultSymbol(a)}(c); }`), '',
  ].join('\n'));
  for (const [a, n] of osNames) if (!starts.has(a)) problems.push(`OS routine ${n} at ${hex(a)} is not a function of the inventory`);

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
    '', ...[...decls].sort(), '', '#endif', '',
  ].join('\n'));

  const reg: string[] = ['#include "oot_gen.h"', ''];
  inv.images.forEach((_, k) => reg.push(`extern const DispatchEntry oot_dispatch_${k}[];`, `extern const uint32_t oot_dispatch_${k}_count;`));
  reg.push('', 'ImageInfo oot_images[] = {');
  inv.images.forEach((img, k) => {
    const { start, end } = imageExtent(img);
    const overlay = img.kind === 'overlay';
    reg.push(`  { "${img.name}", 0x${hex(start)}u, 0x${hex(end)}u, ${overlay ? 1 : 0}, 0, ${overlay ? 0 : 1}, oot_dispatch_${k}, 0 },`);
  });
  reg.push('};', `const uint32_t oot_image_count = ${inv.images.length};`, '');
  reg.push('// The table sizes are defined next to the tables.');
  reg.push('static void __attribute__((constructor)) oot_fill_counts(void) {');
  inv.images.forEach((_, k) => reg.push(`  oot_images[${k}].count = oot_dispatch_${k}_count;`));
  reg.push('}', '');
  emit('images.c', reg.join('\n'));
  return { files, functions, osBindings: bound.length, problems };
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

function imageSource(
  img: InvImage, spec: ImageSpec, index: number, callee: (a: number) => string, starts: Set<number>, problems: string[],
): string {
  const dv = new DataView(spec.bytes.buffer, spec.bytes.byteOffset, spec.bytes.byteLength);
  const relocs = new Map<number, number>();
  for (const r of img.relocations) if (r.section === 'text') relocs.set(r.addr, r.type);
  const jumpTables = new Map<number, number[]>();
  for (const j of img.jumpTables) jumpTables.set(j.site, j.targets);

  const out: string[] = ['#include "oot_gen.h"', ''];
  const entries: [number, string][] = [];
  for (const f of img.functions) {
    const words: number[] = [];
    for (let a = f.start; a < f.end; a += 4) words.push(dv.getUint32(a - spec.base));
    // A trailing branch brings its delay slot, which lies just past the function's last instruction.
    if (decode(words[words.length - 1]!, f.end - 4).kind !== 'plain' && f.end - spec.base + 4 <= spec.bytes.length) {
      words.push(dv.getUint32(f.end - spec.base));
    }
    try {
      const r = recompileFunction({ addr: f.start, words }, {
        callee, relocs, jumpTables, delta: img.kind === 'overlay' ? `${img.name}_delta` : undefined,
      });
      if (r.code.includes('rt_unimpl')) problems.push(`${img.name} ${hex(f.start)}: instruction the recompiler does not translate`);
      for (const c of r.callees) {
        if (!starts.has(c)) problems.push(`${img.name} ${hex(f.start)}: transfers to ${hex(c)}, which is not a function`);
      }
      out.push(r.code);
      entries.push([f.start, callee(f.start)]);
    } catch (e) {
      problems.push(`${img.name} ${hex(f.start)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  entries.sort((a, b) => a[0] - b[0]);
  out.push(`const DispatchEntry oot_dispatch_${index}[] = {`, ...entries.map(([a, n]) => `  { 0x${hex(a)}u, ${n} },`), '};');
  out.push(`const uint32_t oot_dispatch_${index}_count = ${entries.length};`, '');
  return out.join('\n');
}
