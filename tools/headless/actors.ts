// The play context's live actors (docs/re/actors.md): twelve lists, one per category, of records linked through a next pointer.
import { ACTOR_POSITION, CTX_ACTOR_LISTS, type PlayState, type Vec3 } from './state.ts';

/** Lists in the context: the update walk at 0x800253e4 counts 0x60 / 8 of them (`addiu s6, zero, 96` at 0x80025418). */
export const ACTOR_CATEGORIES = 12;
/** Offsets in an actor record: id (halfword), category (byte), room (signed byte), the position triple at `ACTOR_POSITION`, rotation, and the links. */
export const ACTOR_FIELDS = { id: 0x00, category: 0x02, room: 0x03, rotation: 0x30, prev: 0x120, next: 0x124 } as const;
/** Size the record is read to when it is shown: the next pointer ends the fields known here. */
export const ACTOR_RECORD_SIZE = 0x128;
/** Byte in the context that the insert and remove routines (0x800255c4, 0x8002560c) keep as the number of actors in all lists. */
export const CTX_ACTOR_TOTAL = CTX_ACTOR_LISTS - 4;

export interface Actor {
  /** Guest address of the record. */
  addr: number;
  id: number;
  category: number;
  room: number;
  position: Vec3;
  /** Halfwords at `ACTOR_FIELDS.rotation`: x, y, z. */
  rotation: [number, number, number];
}

export interface ActorList {
  category: number;
  /** The count the context keeps for the list. */
  declared: number;
  actors: Actor[];
}

const inRdram = (addr: number) => addr >= 0x80000000 && addr < 0x80800000;

/** Reads a float stored at a guest address from its word. */
function floatOf(rd32: (addr: number) => number, addr: number): number {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, rd32(addr) >>> 0);
  return view.getFloat32(0);
}

const signed16 = (n: number) => (n << 16) >> 16;

export function readActor(rd32: (addr: number) => number, addr: number): Actor {
  const first = rd32(addr) >>> 0;
  const rot = (off: number) => {
    const word = rd32(addr + ACTOR_FIELDS.rotation + (off & ~3)) >>> 0;
    return signed16(off & 2 ? word & 0xffff : word >>> 16);
  };
  return {
    addr,
    id: first >>> 16,
    category: (first >>> 8) & 0xff,
    room: (first << 24) >> 24,
    position: { x: floatOf(rd32, addr + ACTOR_POSITION), y: floatOf(rd32, addr + ACTOR_POSITION + 4), z: floatOf(rd32, addr + ACTOR_POSITION + 8) },
    rotation: [rot(0), rot(2), rot(4)],
  };
}

/** Walks the lists from their heads along the next pointer; a list stops at a null, out-of-memory or repeated pointer. */
export function readActors(rd32: (addr: number) => number, play: PlayState): ActorList[] {
  const lists: ActorList[] = [];
  for (let category = 0; category < ACTOR_CATEGORIES; category++) {
    const entry = play.context + CTX_ACTOR_LISTS + category * 8;
    const actors: Actor[] = [];
    const seen = new Set<number>();
    for (let addr = rd32(entry + 4) >>> 0; inRdram(addr) && !seen.has(addr); addr = rd32(addr + ACTOR_FIELDS.next) >>> 0) {
      seen.add(addr);
      actors.push(readActor(rd32, addr));
    }
    lists.push({ category, declared: rd32(entry) >>> 0, actors });
  }
  return lists;
}

/** The record at `addr` if it is in a list of the context now, else undefined. */
export function findActor(rd32: (addr: number) => number, play: PlayState, addr: number): Actor | undefined {
  for (const list of readActors(rd32, play)) {
    const actor = list.actors.find((a) => a.addr === addr);
    if (actor) return actor;
  }
  return undefined;
}
