# The play context's live actors

Evidence from the PAL 1.0 ROM (SHA-1 `328A1F1BEBA30CE5E178F031662019EB32C5F3B5`). Addresses are virtual; `npx tsx tools/analyze/disasm.ts code <start> <end>` lists them. Names are our labels. A statement marked *observed* comes from running the built game in Kokiri Forest (`tools/headless/actors-rom.test.ts`).

## Where the lists are

- **Twelve lists, one per category.** The play context (`ctx`, the pointer at `0x80112BE0`, `tools/headless/state.ts`) holds an array at `ctx + 0x1C24`. The routine at `0x800253E4` (called from `0x8008126C` with `addiu a1, s0, 7204`, 0x1C24, `s0` being the context) steps through it: `addiu s6, zero, 96` (0x80025418) and the increments of 8 (0x800254A0, 0x800254A8) give 96 / 8 = 12 entries.
- **Entry layout.** Entry `c` is at `a1 + 8 * c`; the routine loads the head with `lw s0, 16(s5)` (0x80025420, entry 0 at `a1`, so the head of category `c` is at `ctx + 0x1C34 + 8c`) and the insert routine keeps a count at `12(v0)` and the head at `16(v0)` with `v0 = a1 + (category << 3)` (`sll`, `addu` at 0x800255D4-0x800255D8, `lw` at 0x800255E4/0x800255E8). So the count of category `c` is the word at `ctx + 0x1C30 + 8c` and its head the word at `ctx + 0x1C34 + 8c`, which is what `docs/re/newgame.md` found for Link (category 2).
- **Total.** The insert routine increments the byte at `8(a0)` (`lbu`/`addiu`/`sb` at 0x800255D0-0x800255E0) and the remove routine decrements it (0x80025614-0x80025624): the number of actors in all lists, at `ctx + 0x1C2C`.

## The record

| Offset | Meaning | Evidence |
| --- | --- | --- |
| `0x00` | id (halfword) | `lh t8, 0(s0)` compared with the wanted id by the search at 0x800287E4 (`beq s2, t8`) |
| `0x02` | category (byte) | `sb a2, 2(a1)` stores it on insert (0x800255CC); the remove routine reads it with `lbu 2(a2)` to find the list (0x80025628) |
| `0x03` | room, signed byte | `lb v0, 3(s0)` (0x8002542C); the update walk skips a negative one (`bltzl`, 0x80025434). Link's is `0xFF` |
| `0x24` | world position, three floats | `0x80021AD8` passes `a0 + 36` and `a1 + 36` to the routine at `0x80064448` (the distance between two actors, used by the search above: `c.le.s` against its limit at 0x80028800); observed to move with the stick for Link |
| `0x30` | rotation, three halfwords (x, y, z) | observed: Link's y is `0x8000` at +0x32 in the house at frame 19000 (the record dump of the probe) |
| `0x120` | previous record in the list (`sw a1, 288(v1)`, 0x800255F8) | observed: the first record's is 0, and every other's is the record before it |
| `0x124` | next record in the list (`sw v1, 292(a1)`, 0x80025600) | the update walk follows it (`lw s0, 292(s0)`, 0x80025438 and others); a list ends at 0 |

Other offsets of the record are not used here and have no proven meaning. Three triples of floats were seen in memory at `0x08`, `0x38` and `0x50`. Link's triple at `0x38` differs slightly from the one at `0x24` while he moves (observed), and "Go to" writes both.

## Insert, remove, walk

- **Insert** (0x800255C4, arguments: the array `a0`, the record `a1`, the category `a2`): stores the category, increments the totals and the list's count, links the new record in front of the old head (`sw a1, 288(v1)` on the old head, `sw v1, 292(a1)` on the new one) and makes it the head (`sw a1, 16(v0)`). New records go first.
- **Remove** (0x8002560C): decrements the totals, unlinks through both pointers (0x80025640-0x80025684), clears the record's links.
- **Walk** (0x800253E4): for each of the 12 entries, `lw s0, 16(s5)`; while `s0` is non-zero it works on the record and continues with `lw s0, 292(s0)`. A category is therefore a singly walked list from head to the null next pointer. The same loop shape is at 0x80025300 (a list-wide pass with `lw s0, 292(s0)` at 0x80025358) and at 0x800287C0-0x8002881C (the search by id, which starts at the head of one category, `lw s0, 7220(t7)`).

## Observed in Kokiri Forest

Entrance 238 of scene 85, 2,410 frames after loading it (as in `headless-forest.test.ts`): 88 actors; categories 1, 2, 4, 6, 7, 8 and 10 held 2, 1, 11, 45, 18, 9 and 2. For every list the walk from the head along `+0x124` ended at the context's count, every record's category byte equalled its list's number, `+0x120` of each record pointed to the one before, and the byte at `ctx + 0x1C2C` was the sum. Positions of the records changed over the next 30 frames.

**Go to.** Writing Link's `0x24` and `0x38` triples to 50 units in +x of an actor puts him there for actors that stand on ground the game accepts: of every fourth actor of the forest (about 22 tried, `actors-rom.test.ts`), more than two ended within 80 units of the actor and at least one was more than 300 units from where Link began. For others (observed: actors at height 0 below Link, or high in the air) Link returned within 8 frames to where he had been or to another place on the ground: the game moves him back when the spot has no floor. The check was not located; nothing here bypasses it.

Category numbers are not named: no code here maps them to a meaning. Link is the single record of category 2 with id 0, as in `docs/re/newgame.md`.

## Light sources

The port's point lights (`web/point-lights.ts`) read the game's own registry of lights, not a list of actor ids: the actors that burn a flame register a point light with the game, and the registry says where it is, how bright and whether it burns. Evidence comes from `tools/gfx/point-light-probe.ts` (one game; `LIGHTS=1`, `DUMP`, `FINDPTR`, `DUMPMEM`), which loads an entrance, runs 150 to 300 frames, lists the actors and projects each onto the picture with the projection the interpreter reports (`gfx_camera_result`: the view matrix is multiplied into the projection stack, `docs/re/gaps.md`, and the room's vertices are drawn with an identity model-view matrix, `docs/re/display-lists.md`; Link's own record lands on Link in every picture).

**How it was found.** In the Fire Temple's first room (scene 4, entrance 357) three records of id `0x0008` (category 7) at (105, 260, -145), (0, 280, -140) and (-105, 260, -145) project onto the three flames at the top of the stairs. Dumping those records past the common fields showed, at `+0x144` of each, twelve bytes that follow the position and colour of a flame: `02 00 | x | y | z | r g b | 00 | radius`. A search of guest memory for words equal to that address (`FINDPTR`) found it in a table at `0x80119B68`: 32 nodes of three words `{info pointer, next, prev}` (12 bytes each; the nodes in use are linked in allocation order, the rest are zero, and the table ends at `0x80119CE8`, where other data starts). Every actor that lights the scene is there.

**The info record** (read from the words at the pointer):

| Offset | Meaning | Evidence |
| --- | --- | --- |
| `+0x00` byte | type: 2 for the point lights here | `02` at every torch, lamp and fairy light seen; `00` and `01` are other kinds (the first two nodes of every scene, `01 ...`, carry what look like the scene's directional lights, `docs/re/lighting.md` section 3) |
| `+0x02`, `+0x04`, `+0x06` s16 | position x, y, z, world units | equals the owner's position with y raised by 40 (id `0x0008`: 260 -> 300) or 70 (id `0x005E`: 813 -> 883); the flame is drawn there |
| `+0x08` three bytes | colour r, g, b | torches 0xEF/0xEF/0x00 down to 0x82/0x82/0x00, a different value in each frame the probe ran: the game's own flicker; white (FF FF FF) for the fairy's lights (id `0x0018`, Link's companion, node pairs at `0x80119B80` and `0x80119B8C`) |
| `+0x0B` byte | 0 for torches, 1 for the first of the fairy's pair | observed only |
| `+0x0C` s16 | radius | 200 (`0x00C8`) on every burning torch; `-1` on every torch that is not burning |

**Lit or not is proven.** Torches that are not burning keep their light registered with colour 0 and radius -1: Goron City (scene 98, entrance 333) and Zora's Domain (scene 88, entrance 264) show six and five such records of id `0x005E` and no flame on screen. The Spirit Temple room (scene 6, entrance 757) has four `0x005E` records, two with colour `0x82`/`0x83` and radius 200 (the two with fire-coloured draws within 30 pixels of their projected position) and two with colour 0; putting Link next to an unlit one shows a bare bundle of sticks with no flame. The port lights a record only when its colour is not 0 and its radius is positive.

**Source coverage** (entrance start views only, with the lights registered after 150 to 300 frames; the entrance table reaches no room deeper in a dungeon):

| Owner id | Category | What it is | Scenes seen (entrance) |
| --- | --- | --- | --- |
| `0x0008` | 7 | wall flame | 4 (357): 3, Fire Temple first room; 16 (99): 2, Treasure Box Shop |
| `0x005E` | 6 | torch on a stand, burning or not | burning: 6 (757): 2 of 4; 10 (1051): 4; 11 (8): 2; 63 (796): 2; 90 (976): 1; not burning: 88 (264): 5; 98 (333): 6 |
| `0x0018` | 7 | the companion fairy | every scene (white, left out) |

No registered flame in the first rooms of scenes 0 and 1 (the Deku Tree and Dodongo's Cavern as entered), in Kakariko Village by day (82, entrance 219) or night (entrances 220 and 221; the glowing windows are part of the room's mesh, not an actor), in the Bazaar (44) or in the other interiors tried (33 to 39, 41 to 43, 45 to 50, 53 to 55, 57; some register only fairy lights). Lamps and lanterns drawn as part of a room's mesh have no light in the registry: the port does not light them.

**User labels.** The Actors tab has a Light button per row: it marks every actor with that id as a light source (kept in the browser, `zelda-oot-js:light-actors`). Those records light a little above their position (20 units), always (their lit state is unknown), and flicker with the port's own sines.

**Probe fire detector.** A batch drawn with an orange primitive colour over a red environment colour is a flame candidate; the nearest actor within 40 pixels is credited. It found id `0x0008` (12 batches) and `0x0013` (64, the flying fire creature) in the Fire Temple and `0x005E` in scenes 6 and 10; in the Bazaar it picks the shelf items, so it only points at candidates.
