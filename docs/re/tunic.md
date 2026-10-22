# Link's tunic colour

Evidence from the PAL 1.0 code file (file-table index 28, loaded so that file offset `o` is RAM `0x800116E0 + o`).

## The table

Nine bytes at file offset `0xE4358` (RAM `0x800F5A38`): `1E 69 1B | 64 14 00 | 00 3C 64`, three RGB triples (green, red-brown, blue). The bytes `1E 69 1B` occur in no other place of the code file's data, and the table has one reference in the whole file: `lui t9, 0x800F` / `addiu t9, t9, 0x5A38` at `0x8007A680`-`0x8007A684`.

## The use

At `0x8007A680` the routine takes an index `i` from the stack (`lw t7, 0x4C(sp)` area, `0x8007A67C`), computes `t8 = 4i - i = 3i` (`sll`, `subu`, `0x8007A688`-`0x8007A68C`), adds the table base, reads the three bytes with `lbu` at offsets 0, 1, 2 (`0x8007A694`, `0x8007A698`, `0x8007A6A8`), shifts and ORs them into one word and stores it at `4(v0)` of a display-list command whose first word is `0xFB000000` (`lui t6, 0xFB00`, `sw t6, 0(v0)` at `0x8007A668`, `0x8007A678`): G_SETENVCOLOR. So index 0 (the first triple, `1E 69 1B` = green) is the environment colour the body is drawn with; indices 1 and 2 are the other two tunics, which this change does not touch.

The same colour paints the cap: the cap turned black together with the tunic in the captures below, so both read this environment colour.

## The change

`rt_patch_tunic` (`runtime/rsp.c`) overwrites the first triple with `20 20 20` in guest RAM, run at each graphics task. It acts only while the bytes still are `1E 69 1B`, so a table that holds anything else is left alone. The ROM and the pack are not edited. Pure black would flatten the model's shading, hence `#202020`.

## Observed

Browser renderer, Kokiri Forest, young Link (`state=1`): the tunic and cap are near-black in the game. On the pause Equipment page the 3D Link is near-black as well (the page draws him with the same routine). The small tunic icon on that page is a 2D texture and stays green. Adult Link was not captured (no saved game with him); he is drawn by the same routine with the same table. Not checked for the other tunics (Goron, Zora): their triples are unchanged.
