// The actors alive in the scene, grouped by category number, and moving Link next to one.
import { readActors, type Actor } from '../../tools/headless/actors.ts';
import type { GuestRam } from '../../tools/headless/load-save.ts';
import { ACTOR_CATEGORY_PLAYER, ACTOR_POSITION, linkPosition, playState, type Vec3 } from '../../tools/headless/state.ts';
import type { Bridge } from './bridge.ts';
import { Refused } from './queue.ts';

export interface ActorRow extends Actor {
  /** Straight-line distance to Link; null when Link is not in the scene. */
  distance: number | null;
}

export interface ActorGroup {
  category: number;
  rows: ActorRow[];
}

export interface ActorsSnapshot {
  scene: number | null;
  link: Vec3 | null;
  /** Non-empty categories in number order, each sorted by distance to Link (ids when Link is absent). */
  groups: ActorGroup[];
  count: number;
  /** Why "Go to" is refused now; undefined when it is allowed. */
  refusal: string | undefined;
}

export const EMPTY_ACTORS: ActorsSnapshot = { scene: null, link: null, groups: [], count: 0, refusal: 'no game is running' };

/** Link's record is the one in the player category's list whose id is 0 (docs/re/newgame.md). */
export const isLink = (a: Actor): boolean => a.category === ACTOR_CATEGORY_PLAYER && a.id === 0;

export function readSnapshot(mem: GuestRam, refusal: string | undefined): ActorsSnapshot {
  const rd32 = (a: number) => mem.rd32(a);
  const play = playState(rd32);
  if (!play) return { ...EMPTY_ACTORS, refusal };
  const link = linkPosition(rd32, play) ?? null;
  const groups: ActorGroup[] = [];
  let count = 0;
  for (const list of readActors(rd32, play)) {
    if (list.actors.length === 0) continue;
    const rows = list.actors.map((a): ActorRow => ({ ...a, distance: link ? Math.hypot(a.position.x - link.x, a.position.y - link.y, a.position.z - link.z) : null }));
    rows.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0) || a.id - b.id);
    count += rows.length;
    groups.push({ category: list.category, rows });
  }
  return { scene: play.scene, link, groups, count, refusal };
}

export function snapshot(bridge: Bridge): ActorsSnapshot {
  const mem = bridge.ram();
  return mem ? readSnapshot(mem, bridge.unsafeReason()) : EMPTY_ACTORS;
}

export function sameSnapshot(a: ActorsSnapshot, b: ActorsSnapshot): boolean {
  if (a.scene !== b.scene || a.count !== b.count || a.refusal !== b.refusal || a.groups.length !== b.groups.length) return false;
  return a.groups.every((g, i) => g.rows.length === b.groups[i]!.rows.length && g.rows.every((r, j) => {
    const o = b.groups[i]!.rows[j]!;
    return r.addr === o.addr && r.id === o.id && r.position.x === o.position.x && r.position.y === o.position.y && r.position.z === o.position.z;
  }));
}

/** How far from the chosen actor, along the world x axis, Link is put. */
export const GO_TO_OFFSET = 50;
/** Offset in Link's record of a second copy of the world position (docs/re/actors.md); it is written with the first so that the two do not disagree for a frame. */
const LINK_SECOND_POSITION = 0x38;

/** Puts Link next to the actor at `addr`; call between frames. Throws a refusal that says why when it cannot. */
export function goToActor(bridge: Bridge, addr: number): string {
  const mem = bridge.writable();
  const rd32 = (a: number) => mem.rd32(a);
  const play = playState(rd32);
  if (!play) throw new Refused('Not now: the game is not in a scene yet');
  const lists = readActors(rd32, play);
  const all = lists.flatMap((l) => l.actors);
  const target = all.find((a) => a.addr === addr);
  const link = all.find(isLink);
  if (!target) throw new Refused('That actor is gone');
  if (!link) throw new Refused('Link is not in the scene');
  if (target === link) throw new Refused('That is Link');
  const view = new DataView(new ArrayBuffer(4));
  const word = (n: number) => { view.setFloat32(0, n); return view.getUint32(0); };
  const spot = { x: target.position.x + GO_TO_OFFSET, y: target.position.y, z: target.position.z };
  for (const base of [ACTOR_POSITION, LINK_SECOND_POSITION]) {
    mem.write32(link.addr + base, word(spot.x));
    mem.write32(link.addr + base + 4, word(spot.y));
    mem.write32(link.addr + base + 8, word(spot.z));
  }
  return `Link moved next to actor ${target.id}`;
}
