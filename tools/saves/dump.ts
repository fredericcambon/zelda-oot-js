// Readable descriptions of a save memory image and of the sample container.
import { parseContainer, payloadStats } from './container.ts';
import { describeRecord } from './record.ts';
import { BACKUP, FIELDS, PRIMARY, RECORD_SIZE, readField, recordAt, verify, type FieldValue } from './sram.ts';

function fields(record: Uint8Array): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const f of FIELDS) out[f.name] = readField(record, f);
  return out;
}

export function dumpSram(sram: Uint8Array): object {
  const v = verify(sram);
  return {
    accepted: v.accepted,
    problems: v.problems,
    header: v.header,
    slots: v.slots.map((s) => {
      const loaded = s.outcome === 'from-backup' ? BACKUP[s.slot]! : PRIMARY[s.slot]!;
      return {
        ...s,
        primaryOffset: PRIMARY[s.slot],
        backupOffset: BACKUP[s.slot],
        recordSize: RECORD_SIZE,
        fields: s.used ? fields(recordAt(sram, loaded)) : undefined,
        decoded: s.used ? describeRecord(recordAt(sram, loaded)) : undefined,
      };
    }),
  };
}

/** An entropy at or above RANDOM_ENTROPY and a repeat fraction at or below RANDOM_REPEAT leave no structure to decode. */
const RANDOM_ENTROPY = 7.9;
const RANDOM_REPEAT = 0.02;

export function dumpSample(file: Uint8Array): object {
  const c = parseContainer(file);
  return {
    container: {
      header: c.header,
      headerBytes: c.headerBytes,
      label: c.id,
      indexTableChecksumOk: c.indexTableChecksumOk,
      indexTableCopyEqual: c.indexTableCopyEqual,
      problems: c.problems,
    },
    notes: c.notes.map((n) => {
      const stats = payloadStats(n.data);
      const noStructure = stats.entropy >= RANDOM_ENTROPY && stats.bestRepeatFraction <= RANDOM_REPEAT;
      return {
        entry: n.entry,
        gameCode: n.gameCode,
        publisher: n.publisher,
        status: n.status,
        nameBytes: n.nameBytes,
        extensionBytes: n.extensionBytes,
        pages: `${n.pages[0]}-${n.pages[n.pages.length - 1]} (${n.pages.length})`,
        fileOffset: `0x${n.fileOffset.toString(16)}`,
        length: n.length,
        comment: n.comment,
        payload: {
          ...stats,
          decoded: false,
          reason: noStructure
            ? 'the bytes show no structure: entropy near 8 bits per byte and no repeats at any distance, so the payload is compressed, encrypted or not a save at all'
            : 'no decoder for this payload',
        },
      };
    }),
  };
}
