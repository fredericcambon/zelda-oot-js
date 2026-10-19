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
| `0x08` | spawn position, three floats | stored from the spawner's arguments (`swc1` at 0x800259A4-0x800259B0); the routine at 0x80021500 copies it to `0x24` (`lw 8`/`sw 36`, `lw 12`/`sw 40`, `lw 16`/`sw 44`, 0x80021500-0x80021518) |
| `0x14` | spawn rotation, three halfwords | stored from the spawner's arguments (`sh` at 0x800259BC-0x800259CC); 0x80021500 copies the words at `0x14` and `0x18` to `0x30` and `0x34` (0x80021510-0x80021524) |
| `0x1C` | spawn parameter (halfword) | stored from the spawner's last argument (`lh 126(sp)`, `sh 28($a3)`, 0x800259D0-0x800259D4) |
| `0x1E` | object slot (signed byte) | the result of the object lookup `jal 0x80081BD8` (0x80025880, on the object table at `ctx + 0x117A4` with the halfword at `8(entry)` as the wanted object), kept in `sp+72` and stored with `sb 30($a3)` (0x80025960 or 0x80025970); the init routine hands it back to the object table (`lb a1, 30(s0)`, `jal 0x80081C38`, 0x800216D4-0x800216D8) and `0x800215D0` reads the slot's entry at `ctx + 0x117B4 + 68 * slot` (0x800215DC-0x800215F0); a negative result makes the spawner give up (`bltz`, 0x8002588C) |
| `0x24` | world position, three floats | `0x80021AD8` passes `a0 + 36` and `a1 + 36` to the routine at `0x80064448` (the distance between two actors, used by the search above: `c.le.s` against its limit at 0x80028800); observed to move with the stick for Link |
| `0x30` | rotation, three halfwords (x, y, z) | copied from the spawn rotation at `0x14` (above); observed in Kokiri Forest: for 81 of 88 actors the words at `0x14` and `0x30` were equal 2,410 frames after the entrance; Link's y is `0x8000` at +0x32 in the house at frame 19000 (the record dump of the probe). The unit of the halfwords is not proven here, so the Actors tab shows them as hexadecimal |
| `0x120` | previous record in the list (`sw a1, 288(v1)`, 0x800255F8) | observed: the first record's is 0, and every other's is the record before it |
| `0x124` | next record in the list (`sw v1, 292(a1)`, 0x80025600) | the update walk follows it (`lw s0, 292(s0)`, 0x80025438 and others); a list ends at 0 |

## Spawn

The spawner is `0x8002573C(list, ctx, id, x, y, z, rot x, rot y, rot z, param)` (the wrapper at 0x80025A1C passes the stack arguments on, `swc1` at 0x80025A54-0x80025A58, `sw` at 0x80025A5C-0x80025A64). It indexes the table at `0x800E6480` with 32-byte entries by the id (`sll a2, 5`, 0x8002576C), loads the actor's code when it is not in memory, looks up its object with the halfword at `8(init entry)` (above), allocates `12(init entry)` bytes (0x800258D0-0x800258D4), and fills the record: id from `0(entry)`, the word at `4(entry)` into `+4`, the spawn position, rotation and parameter above, the room from the byte at `ctx + 0x11CBC` (`lb 7356`, 0x80025998), and the four code pointers from `16..28(entry)` into `+0x128..+0x134` (0x80025974-0x80025994). It inserts the record in its list (`jal 0x800255C4`, 0x800259E0) and runs the init routine at 0x80021608, which first copies position and rotation (0x80021500, 0x80021594).

**Horizontal distance.** Walking Link changed his x and z while his y stayed 100 (observed in Kokiri Forest, stick up then right, 40 frames each: x -30 to 18.4 to 6.8, z 1025 to 1124 to 1119). The Actors tab calls the distance in x and z the one "across x and z only" rather than horizontal, because y being up is not proven by more than this.

Other offsets of the record are not used here and have no proven meaning. Three triples of floats were seen in memory at `0x08`, `0x38` and `0x50`. Link's triple at `0x38` differs slightly from the one at `0x24` while he moves (observed), and "Go to" writes both.

## Insert, remove, walk

- **Insert** (0x800255C4, arguments: the array `a0`, the record `a1`, the category `a2`): stores the category, increments the totals and the list's count, links the new record in front of the old head (`sw a1, 288(v1)` on the old head, `sw v1, 292(a1)` on the new one) and makes it the head (`sw a1, 16(v0)`). New records go first.
- **Remove** (0x8002560C): decrements the totals, unlinks through both pointers (0x80025640-0x80025684), clears the record's links.
- **Walk** (0x800253E4): for each of the 12 entries, `lw s0, 16(s5)`; while `s0` is non-zero it works on the record and continues with `lw s0, 292(s0)`. A category is therefore a singly walked list from head to the null next pointer. The same loop shape is at 0x80025300 (a list-wide pass with `lw s0, 292(s0)` at 0x80025358) and at 0x800287C0-0x8002881C (the search by id, which starts at the head of one category, `lw s0, 7220(t7)`).

## Observed in Kokiri Forest

Entrance 238 of scene 85, 2,410 frames after loading it (as in `headless-forest.test.ts`): 88 actors; categories 1, 2, 4, 6, 7, 8 and 10 held 2, 1, 11, 45, 18, 9 and 2. For every list the walk from the head along `+0x124` ended at the context's count, every record's category byte equalled its list's number, `+0x120` of each record pointed to the one before, and the byte at `ctx + 0x1C2C` was the sum. Positions of the records changed over the next 30 frames.

**Go to.** Writing Link's `0x24` and `0x38` triples to 50 units in +x of an actor puts him there for actors that stand on ground the game accepts: of every fourth actor of the forest (about 22 tried, `actors-rom.test.ts`), more than two ended within 80 units of the actor and at least one was more than 300 units from where Link began. For others (observed: actors at height 0 below Link, or high in the air) Link returned within 8 frames to where he had been or to another place on the ground: the game moves him back when the spot has no floor. The check was not located; nothing here bypasses it.

Category numbers are not named: no code here maps them to a meaning, so the Actors tab calls them "lists" and says so. Link is the single record of category 2 with id 0, as in `docs/re/newgame.md`.
