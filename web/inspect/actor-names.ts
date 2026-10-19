// What each actor id looks like in the game, named by watching it: each entry cites the scene it was seen in and the tile in the
// contact sheets that `npx tsx tools/actors/crops.ts` writes to out/actors/ (evidence in docs/re/actors.md, "Names"). The names
// describe what the picture shows; they are not the game's own names. Keyed by actor id.
export interface ActorName {
  name: string;
  /** Where the name comes from. */
  note: string;
}

export const ACTOR_NAMES: Readonly<Record<number, ActorName>> = {
  0x1a0: { name: 'Wooden crate', note: 'Seen in Market (scene 32) tile 0 of out/actors/scene-32/sheet-0.png; Kakariko Village (scene 82) tile 0 of out/actors/scene-82/sheet-0.png; Lon Lon Ranch (scene 99) tile 0 of out/actors/scene-99/sheet-0.png' },
  0x19d: { name: 'Brick blocks', note: 'Seen in Kakariko Village (scene 82) tile 2 of out/actors/scene-82/sheet-0.png' },
  0x1bc: { name: 'Person in blue', note: 'Seen in Kakariko Village (scene 82) tile 3 of out/actors/scene-82/sheet-0.png' },
  0x178: { name: 'Guard with a spear', note: 'Seen in Kakariko Village (scene 82) tile 4 of out/actors/scene-82/sheet-0.png' },
  0xb3: { name: 'Person with a spear', note: 'Seen in Kakariko Village (scene 82) tile 8 of out/actors/scene-82/sheet-1.png' },
  0x132: { name: 'Person in yellow', note: 'Seen in Kakariko Village (scene 82) tile 5 of out/actors/scene-82/sheet-0.png' },
  0x13c: { name: 'Person in a red cap', note: 'Seen in Kakariko Village (scene 82) tile 6 of out/actors/scene-82/sheet-0.png' },
  0x16e: { name: 'Person in a dark top and green trousers', note: 'Seen in Market (scene 32) tile 1 of out/actors/scene-32/sheet-0.png' },
  0xe7: { name: 'Person with orange hair', note: 'Seen in Market (scene 32) tile 2 of out/actors/scene-32/sheet-0.png' },
  0x19a: { name: 'Person with a white cap', note: 'Seen in Market (scene 32) tile 3 of out/actors/scene-32/sheet-0.png' },
  0x1ad: { name: 'Person in teal clothes', note: 'Seen in Market (scene 32) tile 4 of out/actors/scene-32/sheet-0.png' },
  0x1ac: { name: 'Person in blue and white', note: 'Seen in Market (scene 32) tile 5 of out/actors/scene-32/sheet-0.png' },
  0x19: { name: 'White chicken', note: 'Seen in Market (scene 32) tile 6 of out/actors/scene-32/sheet-0.png; Kakariko Village (scene 82) tile 14 of out/actors/scene-82/sheet-1.png' },
  0x125: { name: 'Leafy plant', note: 'Seen in Kokiri Forest (scene 85) tile 2 of out/actors/scene-85/sheet-0.png; Market (scene 32) tile 7 of out/actors/scene-32/sheet-0.png; Kakariko Village (scene 82) tile 11 of out/actors/scene-82/sheet-1.png' },
  0x14f: { name: 'Leafy plant', note: 'Seen in Kokiri Forest (scene 85) tile 3 of out/actors/scene-85/sheet-0.png' },
  0x77: { name: 'Tree', note: 'Seen in Market (scene 32) tile 8 of out/actors/scene-32/sheet-1.png; Kakariko Village (scene 82) tile 10 of out/actors/scene-82/sheet-1.png; Hyrule Field (scene 81) tile 3 of out/actors/scene-81/sheet-0.png; Lon Lon Ranch (scene 99) tile 2 of out/actors/scene-99/sheet-0.png' },
  0x141: { name: 'Wooden post', note: 'Seen in Kakariko Village (scene 82) tile 12 of out/actors/scene-82/sheet-1.png' },
  0x39: { name: 'Wooden sign', note: 'Seen in Kakariko Village (scene 82) tile 15 of out/actors/scene-82/sheet-1.png; Hyrule Field (scene 81) tile 5 of out/actors/scene-81/sheet-0.png; Kokiri Forest (scene 85) tile 6 of out/actors/scene-85/sheet-0.png' },
  0x14e: { name: 'Rock', note: 'Seen in Kokiri Forest (scene 85) tile 5 of out/actors/scene-85/sheet-0.png; Kakariko Village (scene 82) tile 13 of out/actors/scene-82/sheet-1.png; Hyrule Field (scene 81) tile 4 of out/actors/scene-81/sheet-0.png' },
  0x127: { name: 'Large tan rock', note: 'Seen in Hyrule Field (scene 81) tile 2 of out/actors/scene-81/sheet-0.png' },
  0x1b9: { name: 'Grey rock', note: 'Seen in Kokiri Forest (scene 85) tile 7 of out/actors/scene-85/sheet-0.png' },
  0x111: { name: 'Pot', note: 'Seen in Kakariko Village (scene 82) tile 16 of out/actors/scene-82/sheet-2.png; Lon Lon Ranch (scene 99) tile 3 of out/actors/scene-99/sheet-0.png' },
  0x103: { name: 'Wooden gate frame', note: 'Seen in Kakariko Village (scene 82) tile 17 of out/actors/scene-82/sheet-2.png' },
  0x100: { name: 'Barred gate', note: 'Seen in Kakariko Village (scene 82) tile 18 of out/actors/scene-82/sheet-2.png' },
  0x18: { name: 'Glowing winged light', note: 'Seen in Kokiri Forest (scene 85) tile 8 of out/actors/scene-85/sheet-1.png; Kakariko Village (scene 82) tile 19 of out/actors/scene-82/sheet-2.png; Hyrule Field (scene 81) tile 7 of out/actors/scene-81/sheet-0.png; Inside the Deku Tree (scene 0) tile 2 of out/actors/scene-0/sheet-0.png; Lon Lon Ranch (scene 99) tile 5 of out/actors/scene-99/sheet-0.png' },
  0x97: { name: 'Small yellow glow', note: 'Seen in Kokiri Forest (scene 85) tile 9 of out/actors/scene-85/sheet-1.png' },
  0x15: { name: 'Red blob', note: 'Seen in Kokiri Forest (scene 85) tile 10 of out/actors/scene-85/sheet-1.png' },
  0x9: { name: 'Wooden door', note: 'Seen in Kakariko Village (scene 82) tile 20 of out/actors/scene-82/sheet-2.png' },
  0xa: { name: 'Wooden chest', note: 'Seen in Inside the Deku Tree (scene 0) tile 4 of out/actors/scene-0/sheet-0.png' },
};
