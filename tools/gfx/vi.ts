// The colour image the video interface scans out, read from the OSViContext the game keeps (the runtime commits the
// pending context to the current one at each retrace; layout in runtime/vi.c).
const OS_VI_CURRENT = 0x80006940;
const VC_FRAMEBUFFER = 0x04;
const VS_BLACK = 0x20;

/** Address of the shown image, or 0 when the screen is blanked or no context exists yet. `rd32` reads guest memory. */
export function shownFramebuffer(rd32: (addr: number) => number): number {
  const context = rd32(OS_VI_CURRENT) >>> 0;
  if (context === 0) return 0;
  // The state halfword is the first half of the context's first word.
  if (((rd32(context) >>> 16) & VS_BLACK) !== 0) return 0;
  return rd32(context + VC_FRAMEBUFFER) >>> 0;
}
