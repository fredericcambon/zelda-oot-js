// What each Inventory field is called, with a plain hint. `observed` names come from changing the field in the running game and
// watching the screen (docs/re/saves.md, "Observed effects of the Inventory fields"); the others are neutral on purpose.

export interface FieldName {
  name: string;
  hint: string;
  observed: boolean;
}

const seen = (name: string, hint: string): FieldName => ({ name, hint, observed: true });
const neutral = (name: string, hint: string): FieldName => ({ name, hint, observed: false });

/** The number the pause menu draws under an item slot: only slots 0, 1, 2, 3 and 6 show one, and the menu names their items. */
const AMMO: Record<number, string> = { 0: 'Deku Stick count', 1: 'Deku Nut count', 2: 'Bomb count', 3: 'Fairy Bow ammo', 6: 'Fairy Slingshot ammo' };

export function countName(i: number): FieldName {
  const name = AMMO[i];
  return name
    ? seen(name, `The number drawn under item slot ${i} in the pause menu`)
    : neutral(`Count for item slot ${i}`, 'No number showed under this slot in the pause menu when it was set');
}

/** The pause menu lays the 24 item slots out in rows of six. */
export const slotName = (i: number): FieldName =>
  seen(`Item slot ${i} (row ${Math.floor(i / 6) + 1}, column ${(i % 6) + 1})`, 'A cell of the pause menu item grid; 255 is empty');

export const BUTTON_ITEMS = ['B button item', 'C-left item', 'C-down item', 'C-right item'];

/** The rows of the equipment page, in the order of the four groups. */
export const EQUIP_ROWS = ['Swords', 'Shields', 'Tunics', 'Boots'];

export const FIELD_NAMES = {
  hearts: seen('Heart containers', 'The hearts drawn at the top left; setting it fills the health to match'),
  health: seen('Health', 'Hearts left; shown and edited in hearts, so 2.5 is two and a half hearts'),
  count34: seen('Rupees', 'The number next to the green gem at the bottom left'),
  limit34: seen('Wallet size', '0 holds 99 rupees, 1 holds 200, 2 and 3 hold 500; the counter turns green when it is full'),
  countD0: seen('Spider token count', 'The number next to the spider icon on the Quest Status page (the icon needs quest icon 23)'),
  level32: seen('Magic meter size', '0: no meter, 1: short bar, 2: long bar. The game rebuilds it from the two magic flags when a file loads'),
  byte33: seen('Magic', 'How full the magic bar is: a short bar is full at 48, a long one at 96'),
  flag3A: seen('Has magic meter', 'The magic bar appears once this is set'),
  flag3C: seen('Double magic', 'With the meter, the bar is long when this is set'),
  name: neutral('File name', 'The name typed when the file was made'),
  scene: neutral('Scene', 'The scene the file resumes in; no name for it is proven here, so label it yourself'),
  bytes68: seen('Buttons', 'The items on the B and C buttons'),
  equip: seen('Equipment', 'The equipment page: one row per group, three columns'),
  bitsA4: seen('Quest icons', 'Each number lights one icon on the Quest Status page'),
} satisfies Record<string, FieldName>;

/** The icon each bit of the quest word lights on the Quest Status page when it is the only one set. */
export const QUEST_BITS: readonly string[] = [
  'green medallion', 'red medallion', 'blue medallion', 'orange medallion', 'purple medallion', 'yellow medallion',
  'green song note', 'red song note', 'blue song note', 'orange song note', 'purple song note', 'yellow song note',
  'grey song note (1st of 6)', 'grey song note (2nd)', 'grey song note (3rd)', 'grey song note (4th)', 'grey song note (5th)', 'grey song note (6th)',
  'green stone', 'red stone', 'blue stone',
  'first top-left box', 'second top-left box', 'spider token counter',
];

export const questBitName = (b: number): string => QUEST_BITS[b] ?? `icon ${b}`;
