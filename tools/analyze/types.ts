// Shape of out/inventory.json.

export type Confidence = 'high' | 'medium' | 'low';

export interface InvFunction {
  start: number;
  end: number;
  /** Our name, when an OS signature or another rule identified the routine. */
  name: string | null;
  confidence: Confidence;
  /** How the function was found: entry, jal, pointer, address-taken, reloc-pointer, tail-jump, ghidra, gap. */
  sources: string[];
  evidence: string[];
  /** Direct callees (jal and tail jumps). */
  calls: number[];
}

export interface InvJumpTable {
  addr: number;
  entries: number;
  targets: number[];
  /** Address of the `jr` that dispatches through the table. */
  site: number;
  function: number;
  bound: 'sltiu' | 'scan';
}

export interface InvIndirectCall {
  addr: number;
  function: number;
  /** Register holding the target. */
  reg: string;
  /** Targets Ghidra resolved, when any. */
  targets: number[];
}

export interface InvReloc {
  addr: number;
  /** ELF relocation type number (2 = 32-bit word, 4 = 26-bit jump, 5 = HI16, 6 = LO16). */
  type: number;
  section: 'text' | 'data' | 'rodata';
  target: number | null;
}

export type DataKind =
  | 'jump-table'
  | 'string'
  | 'zero-fill'
  | 'padding'
  | 'referenced'
  | 'pointer-target'
  | 'section-start'
  | 'unreferenced';

export interface InvDataRange {
  start: number;
  end: number;
  kind: DataKind;
  /** Whether the range counts as identified in the coverage numbers. */
  identified: boolean;
}

export interface SectionCoverage {
  name: string;
  start: number;
  end: number;
  bytes: number;
  functionBytes: number;
  paddingBytes: number;
  dataBytes: number;
  unassignedBytes: number;
  percent: number;
}

export interface InvImage {
  name: string;
  kind: 'boot' | 'code' | 'overlay';
  fileIndex: number | null;
  entry: number | null;
  sections: { name: string; start: number; end: number; kind: 'text' | 'data' | 'rodata' | 'bss' }[];
  functions: InvFunction[];
  jumpTables: InvJumpTable[];
  indirectCalls: InvIndirectCall[];
  relocations: InvReloc[];
  data: InvDataRange[];
  coverage: SectionCoverage[];
  ghidra: { functions: number; agree: number; onlyGhidra: number; onlyOurs: number } | null;
}

export interface Inventory {
  version: 1;
  rom: { sha1: string };
  tool: { name: string; version: string };
  layout: unknown;
  images: InvImage[];
  os: unknown;
}
