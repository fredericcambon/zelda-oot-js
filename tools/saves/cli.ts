// `npm run save -- <command>`: reads, builds and edits the save memory of the game (docs/re/saves.md).
//   dump sram <sram.bin>                       every known field of each file, with the state of both copies
//   dump sample <file>                         the container, the note and what can be said about its payload
//   verify <sram.bin>                          whether the game's own checks accept the image (exit 1 when it would change something)
//   new --slot N --name <name> --out <sram.bin> [--in <sram.bin>] [field=value...]
//   set <sram.bin> --slot N field=value... [--out <sram.bin>]     edits in place unless --out is given
//   import <file> --out <sram.bin>             a raw PAL save memory image (.sra); a Controller Pak dump is reported unsupported
import { readFileSync, writeFileSync } from 'node:fs';
import { DEXDRIVE_MAGIC } from './container.ts';
import { dumpSample, dumpSram } from './dump.ts';
import { blankImage, getRecord, importRawImage, putRecord, SRAM_IMAGE_SIZE } from './image.ts';
import { FIELD_HELP, editRecord, newRecord } from './record.ts';
import { FIELDS, verify } from './sram.ts';

const USAGE = `usage: save dump sram <sram.bin> | dump sample <file> | verify <sram.bin>
       save new --slot N --name <name> --out <sram.bin> [--in <sram.bin>] [field=value...]
       save set <sram.bin> --slot N field=value... [--out <sram.bin>]
       save import <file> --out <sram.bin>
fields: ${FIELD_HELP.join(' ')}`;

const read = (path: string) => new Uint8Array(readFileSync(path));

interface Parsed {
  positional: string[];
  flags: Map<string, string>;
  edits: [string, string][];
}

function parse(args: string[]): Parsed {
  const out: Parsed = { positional: [], flags: new Map(), edits: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const v = args[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      out.flags.set(a.slice(2), v);
    } else if (a.includes('=')) {
      const at = a.indexOf('=');
      out.edits.push([a.slice(0, at), a.slice(at + 1)]);
    } else out.positional.push(a);
  }
  return out;
}

function slotOf(p: Parsed): number {
  const s = p.flags.get('slot');
  if (s === undefined || !/^\d+$/.test(s)) throw new Error('--slot N is required');
  return Number(s);
}

function needOut(p: Parsed): string {
  const out = p.flags.get('out');
  if (!out) throw new Error('--out <sram.bin> is required');
  return out;
}

function report(path: string, sram: Uint8Array): number {
  const v = verify(sram);
  console.log(JSON.stringify({ wrote: path, accepted: v.accepted, problems: v.problems }, null, 2));
  return v.accepted ? 0 : 1;
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  try {
    const p = parse(rest);
    if (cmd === 'dump' && (p.positional[0] === 'sram' || p.positional[0] === 'sample') && p.positional[1]) {
      const bytes = read(p.positional[1]);
      console.log(JSON.stringify(p.positional[0] === 'sram' ? dumpSram(bytes) : dumpSample(bytes), null, 2));
      return 0;
    }
    if (cmd === 'verify' && p.positional[0]) {
      const v = verify(read(p.positional[0]));
      console.log(JSON.stringify(v, null, 2));
      return v.accepted ? 0 : 1;
    }
    if (cmd === 'new') {
      const slot = slotOf(p);
      const out = needOut(p);
      const name = p.flags.get('name');
      if (name === undefined) throw new Error('--name <name> is required');
      const base = p.flags.get('in');
      const sram = blankImage();
      if (base) sram.set(read(base).subarray(0, SRAM_IMAGE_SIZE));
      const record = newRecord(name);
      editRecord(record, p.edits);
      putRecord(sram, slot, record);
      writeFileSync(out, sram);
      return report(out, sram);
    }
    if (cmd === 'set' && p.positional[0]) {
      const slot = slotOf(p);
      const sram = read(p.positional[0]);
      const record = getRecord(sram, slot);
      if (!record) throw new Error(`slot ${slot} holds no file; create it with "new"`);
      editRecord(record, p.edits);
      putRecord(sram, slot, record);
      const out = p.flags.get('out') ?? p.positional[0];
      writeFileSync(out, sram);
      return report(out, sram);
    }
    if (cmd === 'import' && p.positional[0]) {
      const bytes = read(p.positional[0]);
      if (Buffer.from(bytes.subarray(0, DEXDRIVE_MAGIC.length)).toString('latin1') === DEXDRIVE_MAGIC) {
        throw new Error(`unsupported: a DexDrive Controller Pak dump; its note payload cannot be decoded (docs/re/saves.md, "The payload"), so no field is mapped; unmapped: ${FIELDS.map((f) => f.name).join(", ")}`);
      }
      const sram = importRawImage(bytes);
      const out = needOut(p);
      writeFileSync(out, sram);
      return report(out, sram);
    }
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  console.error(USAGE);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
