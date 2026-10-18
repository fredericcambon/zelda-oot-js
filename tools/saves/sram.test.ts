import { describe, expect, it } from 'vitest';
import {
  BACKUP, CHECKSUM_AT, FIELDS, MAGIC, MAGIC_AT, PRIMARY, RECORD_SIZE, SIGNATURE, SIGNATURE_AT, SRAM_USED,
  checksum, isUsed, readField, sealRecord, storedChecksum, verify,
} from './sram.ts';

function record(fill: (r: Uint8Array) => void = () => {}): Uint8Array {
  const r = new Uint8Array(RECORD_SIZE);
  fill(r);
  sealRecord(r);
  return r;
}

const usedFile = (r: Uint8Array) => {
  r.set(MAGIC, MAGIC_AT);
  r[0x2f] = 0x30;
  r[0x31] = 0x30;
};

function image(slots: (Uint8Array | undefined)[]): Uint8Array {
  const sram = new Uint8Array(SRAM_USED);
  sram.set(SIGNATURE, SIGNATURE_AT);
  slots.forEach((r, i) => {
    if (!r) return;
    sram.set(r, PRIMARY[i]);
    sram.set(r, BACKUP[i]);
  });
  return sram;
}

describe('checksum', () => {
  it('is the 16-bit sum of the big-endian halfwords of the first 0x1354 bytes with the checksum halfword left out', () => {
    const r = new Uint8Array(RECORD_SIZE);
    r.set([0x12, 0x34, 0xff, 0xff, 0x00, 0x02], 0);
    expect(checksum(r)).toBe((0x1234 + 0xffff + 2) & 0xffff);
    r[CHECKSUM_AT] = 0xab;
    expect(checksum(r)).toBe((0x1234 + 0xffff + 2) & 0xffff);
  });

  it('ignores the bytes after the checked area', () => {
    const r = new Uint8Array(RECORD_SIZE);
    r[0x1354] = 0x77;
    r[RECORD_SIZE - 1] = 0x55;
    expect(checksum(r)).toBe(0);
  });

  it('is stored by sealRecord and read back', () => {
    const r = record((x) => (x[0x41] = 0x99));
    expect(storedChecksum(r)).toBe(0x99);
  });

  it('passes for an all-zero record, which is how an empty file is stored', () => {
    expect(checksum(new Uint8Array(RECORD_SIZE))).toBe(0);
  });
});

describe('isUsed', () => {
  it('needs one byte of the magic, as the file select does', () => {
    const r = new Uint8Array(RECORD_SIZE);
    expect(isUsed(r)).toBe(false);
    r[MAGIC_AT + 3] = MAGIC[3]!;
    expect(isUsed(r)).toBe(true);
  });
});

describe('verify', () => {
  it('accepts a header with the signature and sealed records in both copies', () => {
    const v = verify(image([record(usedFile), undefined, record(usedFile)]));
    expect(v.problems).toEqual([]);
    expect(v.accepted).toBe(true);
    expect(v.slots.map((s) => s.used)).toEqual([true, false, true]);
    expect(v.slots.every((s) => s.copiesEqual)).toBe(true);
  });

  it('accepts an empty image only once the header is written', () => {
    expect(verify(new Uint8Array(SRAM_USED)).accepted).toBe(false);
    expect(verify(image([])).accepted).toBe(true);
  });

  it('reports a wrong signature', () => {
    const sram = image([record(usedFile)]);
    sram[SIGNATURE_AT + 4] = sram[SIGNATURE_AT + 4]! ^ 1;
    const v = verify(sram);
    expect(v.accepted).toBe(false);
    expect(v.header.signatureOk).toBe(false);
  });

  it('restores from the backup when only the primary fails', () => {
    const sram = image([record(usedFile)]);
    sram[PRIMARY[0] + 0x50] = sram[PRIMARY[0] + 0x50]! ^ 1;
    const v = verify(sram);
    expect(v.slots[0]!).toMatchObject({ primary: 'bad-checksum', backup: 'ok', outcome: 'from-backup', used: true });
    expect(v.accepted).toBe(false);
  });

  it('resets a slot whose two copies fail', () => {
    const sram = image([record(usedFile)]);
    sram[PRIMARY[0] + 0x50] = sram[PRIMARY[0] + 0x50]! ^ 1;
    sram[BACKUP[0] + 0x50] = sram[BACKUP[0] + 0x50]! ^ 1;
    const v = verify(sram);
    expect(v.slots[0]!).toMatchObject({ outcome: 'reset', used: false });
    expect(v.problems.join('\n')).toMatch(/slot 0: neither copy/);
  });

  it('warns about a backup that differs while the primary passes', () => {
    const sram = image([record(usedFile)]);
    sram.set(record((r) => { usedFile(r); r[0x60] = 5; }), BACKUP[0]);
    const v = verify(sram);
    expect(v.accepted).toBe(true);
    expect(v.slots[0]!.copiesEqual).toBe(false);
    expect(v.problems.join('\n')).toMatch(/backup differs/);
  });

  it('rejects a language the game would reset', () => {
    const sram = image([]);
    sram[2] = 3;
    expect(verify(sram).accepted).toBe(false);
  });

  it('refuses an image shorter than the area the game uses', () => {
    expect(() => verify(new Uint8Array(SRAM_USED - 1))).toThrow(/shorter/);
  });

  it('accepts a larger image such as the 128 KB the runtime keeps', () => {
    const big = new Uint8Array(0x20000);
    big.set(image([record(usedFile)]));
    expect(verify(big).accepted).toBe(true);
  });
});

describe('readField', () => {
  it('reads unsigned big-endian integers and raw bytes', () => {
    const r = record((x) => {
      x.set([0, 0, 0, 0xbb], 0);
      x.set([0x0a, 0x3e], 0x24);
    });
    const field = (name: string) => FIELDS.find((f) => f.name === name)!;
    expect(readField(r, field('entranceIndex'))).toBe(0xbb);
    expect(readField(r, field('name'))).toBe('0a3e000000000000');
  });
});
