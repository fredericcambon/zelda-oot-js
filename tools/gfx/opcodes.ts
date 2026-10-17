// Display-list command codes the game uses (see docs/re/display-lists.md for the evidence of each).

export const Op = {
  VTX: 0x01,
  /** Modifies a field of a loaded vertex (colour, texture coordinates, screen position or depth). */
  MODIFYVTX: 0x02,
  CULLDL: 0x03,
  /** Branches to the address of the preceding RDPHALF_1 when a loaded vertex's w is below the command's value. */
  BRANCH_Z: 0x04,
  TRI1: 0x05,
  TRI2: 0x06,
  QUAD: 0x07,
  /** Opcodes 0x09 and 0x0A belong to the 2D microcode (see LOAD_UCODE), not to the 3D one. */
  BG_1CYC: 0x09,
  BG_COPY: 0x0a,
  TEXTURE: 0xd7,
  POPMTX: 0xd8,
  GEOMETRYMODE: 0xd9,
  MTX: 0xda,
  MOVEWORD: 0xdb,
  MOVEMEM: 0xdc,
  LOAD_UCODE: 0xdd,
  DL: 0xde,
  ENDDL: 0xdf,
  RDPHALF_1: 0xe1,
  SETOTHERMODE_L: 0xe2,
  SETOTHERMODE_H: 0xe3,
  TEXRECT: 0xe4,
  RDPLOADSYNC: 0xe6,
  RDPPIPESYNC: 0xe7,
  RDPTILESYNC: 0xe8,
  RDPFULLSYNC: 0xe9,
  SETSCISSOR: 0xed,
  SETOTHERMODE: 0xef,
  LOADTLUT: 0xf0,
  RDPHALF_2: 0xf1,
  SETTILESIZE: 0xf2,
  LOADBLOCK: 0xf3,
  LOADTILE: 0xf4,
  SETTILE: 0xf5,
  FILLRECT: 0xf6,
  SETFILLCOLOR: 0xf7,
  SETFOGCOLOR: 0xf8,
  SETBLENDCOLOR: 0xf9,
  SETPRIMCOLOR: 0xfa,
  SETENVCOLOR: 0xfb,
  SETCOMBINE: 0xfc,
  SETTIMG: 0xfd,
  SETZIMG: 0xfe,
  SETCIMG: 0xff,
} as const;

/** Operation of the MOVEWORD command (byte 1 of the first word). */
export const MoveWord = { NUMLIGHT: 0x02, CLIP: 0x04, SEGMENT: 0x06, FOG: 0x08, PERSPNORM: 0x0e } as const;

/** Target of the MOVEMEM command (byte 3 of the first word). */
export const MoveMem = { VIEWPORT: 0x08, LIGHT: 0x0a } as const;

/** Bits of the geometry mode. */
export const Geo = {
  ZBUFFER: 0x000001,
  SHADE: 0x000004,
  CULL_FRONT: 0x000200,
  CULL_BACK: 0x000400,
  FOG: 0x010000,
  LIGHTING: 0x020000,
  TEXTURE_GEN: 0x040000,
  TEXTURE_GEN_LINEAR: 0x080000,
  SHADING_SMOOTH: 0x200000,
} as const;

/** Bits of the MTX command's parameter byte (after undoing the inversion of the push bit). */
export const MtxParam = { PROJECTION: 0x04, LOAD: 0x02, PUSH: 0x01 } as const;
