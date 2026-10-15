// Recognises the operating-system routines the runtime will replace, using the rules in data/os-signatures.json.
//
// A rule is a conjunction of checks on one function: opening instruction words, COP0 registers, cache operations,
// hardware registers touched through constant addresses, constant RAM addresses, counts of instructions and
// callees, and calls to routines recognised earlier. A rule is accepted only when exactly one function of its
// image matches; anything else is reported, never guessed.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RomContext } from './context.ts';
import { Code, descend } from './discover.ts';
import { extractFeatures, type FunctionFeatures } from './features.ts';
import type { ImageSpec } from './image.ts';
import type { InvImage } from './types.ts';

export interface Match {
  /** Instruction words (hex) the function opens with. */
  startsWith?: string[];
  /** Instruction words (hex, optionally `value/mask`) that appear in this order somewhere in the function. */
  words?: string[];
  /** Instruction words that must not appear. */
  noWords?: string[];
  insns?: [number, number];
  cacheOps?: number[];
  cop0Read?: number[];
  cop0Write?: number[];
  /** Special instructions that must occur (at least once) and must not occur. */
  special?: string[];
  noSpecial?: string[];
  /** Hardware registers (hex KSEG1 addresses) that must be touched. */
  hwAll?: string[];
  /** Exactly these hardware registers are touched, no others. */
  hwOnly?: string[];
  /** Constant RAM addresses (hex) the function dereferences. */
  globalsAll?: string[];
  /** Number of distinct direct callees. */
  callCount?: [number, number];
  /** Callees that must include these routines (by id). */
  calls?: string[];
  /** Routines (by id) that never match, so a rule can say "every caller except these". */
  except?: string[];
  /** Routines (by id) that must call this one. */
  calledBy?: string[];
  backBranches?: [number, number];
  /** Number of `jr` instructions other than returns. */
  indirectJumps?: [number, number];
}

export interface OsRule {
  id: string;
  category: string;
  image: 'boot' | 'code';
  summary: string;
  /** Why the match is the routine: what the code does that nothing else in the image does. */
  evidence: string;
  match: Match;
}

export interface NotPresent {
  id: string;
  category: string;
  summary: string;
  evidence: string;
  /** Checks that must find no function in any image. */
  absent: Match & { image?: 'boot' | 'code' };
}

export interface SignatureFile {
  rules: OsRule[];
  notPresent: NotPresent[];
}

export interface OsRoutine {
  id: string;
  category: string;
  status: 'found' | 'not-present' | 'ambiguous' | 'not-found';
  image: string | null;
  addr: number | null;
  end: number | null;
  candidates: number[];
  summary: string;
  evidence: string;
}

export interface OsResult {
  routines: OsRoutine[];
}

const parseHex = (s: string) => parseInt(s, 16) >>> 0;

export function loadSignatures(path?: string): SignatureFile {
  const here = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(readFileSync(path ?? resolve(here, '..', '..', 'data', 'os-signatures.json'), 'utf8')) as SignatureFile;
}

interface Candidate {
  start: number;
  end: number;
  words: number[];
  feat: FunctionFeatures;
}

function inRange(n: number, r?: [number, number]) {
  return !r || (n >= r[0] && n <= r[1]);
}

function sameSet(a: number[], b: number[]) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Subsequence match of `value/mask` patterns against the function's instruction words in address order. */
function wordsMatch(words: number[], patterns: string[]): boolean {
  let k = 0;
  for (const w of words) {
    if (k >= patterns.length) break;
    const [v, m] = patterns[k]!.split('/');
    const mask = m ? parseHex(m) : 0xffffffff;
    if (((w ^ parseHex(v!)) & mask) === 0) k++;
  }
  return k === patterns.length;
}

export function matches(c: Candidate, m: Match, resolved: Map<string, number>, callers: Map<number, Set<number>>): boolean {
  const f = c.feat;
  if (m.except?.some((id) => resolved.get(id) === c.start)) return false;
  if (!inRange(f.insns, m.insns)) return false;
  if (m.startsWith) {
    if (c.words.length < m.startsWith.length) return false;
    for (let i = 0; i < m.startsWith.length; i++) {
      const [v, mk] = m.startsWith[i]!.split('/');
      const mask = mk ? parseHex(mk) : 0xffffffff;
      if (((c.words[i]! ^ parseHex(v!)) & mask) !== 0) return false;
    }
  }
  if (m.words && !wordsMatch(c.words, m.words)) return false;
  // A `noWords` entry may be a comma-separated sequence that must not occur in order.
  for (const p of m.noWords ?? []) if (wordsMatch(c.words, p.split(','))) return false;
  if (m.cacheOps && !sameSet(f.cacheOps, [...m.cacheOps].sort((a, b) => a - b))) return false;
  if (m.cop0Read && !sameSet(f.cop0Read, [...m.cop0Read].sort((a, b) => a - b))) return false;
  if (m.cop0Write && !sameSet(f.cop0Write, [...m.cop0Write].sort((a, b) => a - b))) return false;
  for (const s of m.special ?? []) if (!f.special[s]) return false;
  for (const s of m.noSpecial ?? []) if (f.special[s]) return false;
  if (m.hwAll && !m.hwAll.every((h) => f.hw.includes(parseHex(h)))) return false;
  if (m.hwOnly && !sameSet(f.hw, m.hwOnly.map(parseHex).sort((a, b) => a - b))) return false;
  if (m.globalsAll && !m.globalsAll.every((g) => f.globals.includes(parseHex(g)))) return false;
  if (m.callCount && !inRange(new Set(f.calls).size, m.callCount)) return false;
  if (!inRange(f.backBranches, m.backBranches)) return false;
  if (!inRange(f.indirectJumps, m.indirectJumps)) return false;
  for (const id of m.calls ?? []) {
    const target = resolved.get(id);
    if (target === undefined || !f.calls.includes(target)) return false;
  }
  for (const id of m.calledBy ?? []) {
    const caller = resolved.get(id);
    if (caller === undefined || !callers.get(c.start)?.has(caller)) return false;
  }
  return true;
}

export function identifyOs(_ctx: RomContext, specs: ImageSpec[], images: InvImage[], sigs: SignatureFile = loadSignatures()): OsResult {
  const perImage = new Map<string, Candidate[]>();
  // Callers are collected across images: the boot code calls into the main code file.
  const callers = new Map<number, Set<number>>();
  for (const name of ['boot', 'code'] as const) {
    const spec = specs.find((s) => s.name === name);
    const img = images.find((s) => s.name === name);
    if (!spec || !img) continue;
    const code = new Code({ base: spec.base, bytes: spec.bytes, limit: spec.base + spec.bytes.length });
    const starts = new Set(img.functions.map((f) => f.start));
    const list: Candidate[] = [];
    for (const f of img.functions) {
      const d = descend(code, f.start, starts, new Set());
      const feat = extractFeatures(code, f, d.visited);
      const words: number[] = [];
      for (const a of [...d.visited].sort((x, y) => x - y)) words.push(code.word(a));
      list.push({ start: f.start, end: f.end, words, feat });
      for (const t of f.calls) {
        const s = callers.get(t) ?? new Set();
        s.add(f.start);
        callers.set(t, s);
      }
    }
    perImage.set(name, list);
  }

  const resolved = new Map<string, number>();
  const out = new Map<string, OsRoutine>();
  const pending = [...sigs.rules];
  for (let round = 0; round < 12; round++) {
    let progress = false;
    for (const rule of [...pending]) {
      const list = perImage.get(rule.image) ?? [];
      const hits = list.filter((c) => matches(c, rule.match, resolved, callers));
      if (hits.length === 1) {
        const c = hits[0]!;
        resolved.set(rule.id, c.start);
        out.set(rule.id, {
          id: rule.id, category: rule.category, status: 'found', image: rule.image, addr: c.start, end: c.end, candidates: [],
          summary: rule.summary, evidence: rule.evidence,
        });
        pending.splice(pending.indexOf(rule), 1);
        progress = true;
      }
    }
    if (!progress) break;
  }
  for (const rule of pending) {
    const list = perImage.get(rule.image) ?? [];
    const hits = list.filter((c) => matches(c, rule.match, resolved, callers));
    out.set(rule.id, {
      id: rule.id, category: rule.category, status: hits.length ? 'ambiguous' : 'not-found', image: rule.image, addr: null, end: null,
      candidates: hits.map((h) => h.start), summary: rule.summary, evidence: rule.evidence,
    });
  }
  for (const np of sigs.notPresent) {
    const hitsAnywhere: number[] = [];
    for (const [name, list] of perImage) {
      if (np.absent.image && np.absent.image !== name) continue;
      for (const c of list) if (matches(c, np.absent, resolved, callers)) hitsAnywhere.push(c.start);
    }
    out.set(np.id, {
      id: np.id, category: np.category, status: hitsAnywhere.length ? 'ambiguous' : 'not-present', image: null, addr: null, end: null,
      candidates: hitsAnywhere, summary: np.summary, evidence: np.evidence,
    });
  }

  // Name the functions in the inventory.
  for (const r of out.values()) {
    if (r.status !== 'found' || !r.image || r.addr === null) continue;
    const fn = images.find((i) => i.name === r.image)?.functions.find((f) => f.start === r.addr);
    if (fn) {
      fn.name = r.id;
      fn.evidence.push(`OS routine ${r.id}: ${r.evidence}`);
    }
  }
  return { routines: [...out.values()].sort((a, b) => (a.addr ?? Infinity) - (b.addr ?? Infinity) || a.id.localeCompare(b.id)) };
}
