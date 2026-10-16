// The shapes of dist/assets/manifest.json.

export type AssetType =
  | 'header'
  | 'boot'
  | 'filetable'
  | 'code'
  | 'overlay'
  | 'scene'
  | 'room'
  | 'object'
  | 'texture-bank'
  | 'audio-bank'
  | 'sequence'
  | 'sample-table'
  | 'animation-bank'
  | 'text'
  | 'data'
  | 'unknown';

/** Display lists, vertex arrays, textures, palettes and animations found in a file; offsets are in the decompressed file. */
export interface GfxContents {
  /** Segment number the file's own pointers use. */
  segment: number;
  /** `[offset, bytes, commands]` */
  displayLists: [number, number, number][];
  /** `[offset, vertices]` of 16 bytes each. */
  vertices: [number, number][];
  /** `[offset, bytes, fmt, siz, width, height, palette offset or -1]`; fmt 0 RGBA, 2 CI, 3 IA, 4 I; siz 0 4-bit, 1 8-bit, 2 16-bit, 3 32-bit. */
  textures: [number, number, number, number, number, number, number][];
  /** `[offset, colors]` of 16 bits each. */
  palettes: [number, number][];
  /** `[offset, frames, frame data offset, joint index offset, static index max]` */
  animations: [number, number, number, number, number][];
  /** Pointers into other files by segment number. */
  external: Record<string, number>;
}

export interface Contents {
  gfx?: GfxContents;
  overlay?: {
    linkStart: number;
    linkEnd: number;
    text: number;
    data: number;
    rodata: number;
    bss: number;
    relocations: number;
    /** Address of the descriptor record in the main code file. */
    descriptor: number;
  };
  scene?: {
    /** Position in the scene table. */
    id: number;
    /** The four bytes after the ranges in the scene table record. */
    flags: number[];
    /** File index of the title card, when the record names one. */
    title: number | null;
    /** File indices of the rooms, in room-number order. */
    rooms: number[];
    /** `[id, arg, value]` per header command. */
    commands: [number, number, number][];
  };
  room?: { scene: number; sceneId: number; number: number; commands: [number, number, number][] };
  object?: { ids: number[] };
  /** Audio index table: `[offset, size, medium]` per record, offsets inside this file. */
  index?: { table: number; entries: [number, number, number][] };
  texture?: { width: number; height: number; fmt: number; siz: number; count: number; palette?: number; smoothness: number };
}

export interface AssetEntry {
  /** File-table index, or null for a range of the ROM the file table does not name. */
  file: number | null;
  /** Path below dist/assets. */
  path: string;
  /** ROM range holding the stored bytes (compressed when the file is). */
  rom: [number, number];
  /** Virtual range of the decompressed file, in the file table's addresses. */
  virtual: [number, number] | null;
  compressed: boolean;
  /** Bytes once decompressed. */
  size: number;
  type: AssetType;
  subtype?: string;
  evidence: string[];
  /** Why a `data` or `unknown` entry is not classified further. */
  reason?: string;
  contents?: Contents;
}

export interface AssetManifest {
  format: 1;
  rom: { sha1: string; size: number; gameCode: string };
  /** ROM offset of the file table and its record count. */
  fileTable: { offset: number; records: number };
  /** Entries per type. */
  counts: Record<string, number>;
  /** Entries in ROM order; their ROM ranges tile the image. */
  entries: AssetEntry[];
}
