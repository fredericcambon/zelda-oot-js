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

Actors the port treats as point-light sources (`web/point-lights.ts`, `LIGHT_ACTOR_IDS`). The game has no such lights; this list is the port's own, and each entry needs an observation.

| Id | Category | Observed | Evidence |
| --- | --- | --- | --- |
| `0x0008` | 7 | Fire Temple, first room (scene 4, entrance 357, 300 frames after loading it) | Three records, `0x801E50D0` at (105, 260, -145), `0x801E4F40` at (0, 280, -140), `0x801E4DB0` at (-105, 260, -145), rotation 0. With the projection the interpreter reports for the frame (below) each position falls on one of the three flames at the top of the stairs (`tools/gfx/point-light-probe.ts 4`, a picture with the id written at every actor's projected position). Of the 76 batches drawn with a fire colour (primitive colour orange, environment colour red) in the last 12 frames, 12 had id `0x0008` as the nearest actor within 40 pixels and 64 had id `0x0013` (category 5, two records near (228, 349, 245) and (-155, 372, 224): the flying fire creature seen at the top of the picture, not a torch). |

- **Lit or not.** Whether a record is lit is not proven: nothing was found that differs between a burning and an unlit one, and only burning ones were seen. Every instance of the listed ids lights.
- **Light position.** The actor's world position (`+0x24`), 20 units higher.
- **Not found.** Probes of scenes 0, 1, 3, 5, 6, 7 (dungeon first rooms), 82 (Kakariko Village, by day), 98 and 40 found no other fire-coloured draw near an actor, so no source is listed for Kakariko or the interiors tried. The page can only light what this table lists; the Kakariko-at-night and interior-with-a-fire captures were not made for that reason.
- **Projection used for the check.** The interpreter reports the perspective projection under which most vertices of a task were transformed (`gfx_camera_result`, `runtime/gfx/gfx.h`): the game multiplies the view matrix into the projection stack (`docs/re/gaps.md`, "view matrix multiplied into the projection"), and the room's own vertices are drawn with an identity model-view matrix (`docs/re/display-lists.md`), so `(x, y, z, 1)` times it is the clip-space position of a world position. Link's own record lands on Link in every frame probed (scenes 0, 1, 3, 4, 5, 7, 82).
