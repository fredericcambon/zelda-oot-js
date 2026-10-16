// Files whose role was worked out by reading the code that loads them. Each entry names the code sites that must still
// load the file (checked against the ROM being processed) so that a mismatch leaves the file unclassified.
import type { AssetType, Confidence } from './classify.ts';

export interface Knowledge {
  type: AssetType;
  label: string;
  confidence: Confidence;
  evidence: string[];
  /** Literal references to the file's virtual start that the analysis relies on. */
  sites: { image: string; addr: number }[];
  contents?: Record<string, unknown>;
}

/** Keyed by the virtual start of the file in the PAL 1.0 file table. */
const KNOWLEDGE = new Map<number, Knowledge>([
  [0x4da490, {
    type: 'animation',
    label: 'per-frame joint rotation data read one frame per transfer',
    confidence: 'medium',
    evidence: [
      '0x8008BB20-0x8008BB78: the transfer size is (limb count * 3 * 2) + 2 bytes, and the ROM address is the file start 0x4DA490 + (the low 24 bits of a word of a record) + frame * that size, passed to dma_request_send (0x80000E68)',
      'so the file is a sequence of frames of 6n+2 bytes (n limbs of three 16-bit rotations plus two bytes), fetched one frame at a time',
    ],
    sites: [{ image: 'code', addr: 0x8008bb58 }],
    contents: { frameBytes: 'limbs * 6 + 2' },
  }],
]);

export function knowledgeFor(virtualStart: number): Knowledge | undefined {
  return KNOWLEDGE.get(virtualStart);
}
