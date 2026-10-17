// The video interface: the two VI contexts the game edits through osVi* calls, and the 50 Hz retrace that
// commits the next context to the current one and notifies the game.
#include "rt.h"

#define OS_VI_CONTEXTS 0x800068e0u
#define OS_VI_CURRENT 0x80006940u // pointer words
#define OS_VI_NEXT 0x80006944u
#define OS_VI_ACTIVE 0x80006a50u // set once osCreateViManager has run
#define VI_CONTEXT_SIZE 0x30u

// OSViContext
#define VC_STATE 0x00 // halfword
#define VC_RETRACE 0x02 // halfword: retraces between notifications
#define VC_FRAMEBUFFER 0x04
#define VC_MODE 0x08
#define VC_CONTROL 0x0c
#define VC_QUEUE 0x10
#define VC_MESSAGE 0x14
#define VC_YSCALE 0x18
#define VC_XSCALE 0x24

enum {
  VS_MODE = 0x01,
  VS_YSCALE = 0x02,
  VS_XSCALE = 0x04,
  VS_FEATURES = 0x08,
  VS_FRAMEBUFFER = 0x10,
  VS_BLACK = 0x20,
};

static uint32_t vi_hz = RT_VI_HZ_PAL;
static uint64_t next_retrace;
static uint32_t retraces;
static uint32_t since_notice;

static uint32_t cur(void) { return rd32(OS_VI_CURRENT); }
static uint32_t nxt(void) { return rd32(OS_VI_NEXT); }
static void state_or(uint32_t ctx, unsigned bits) { wr16(ctx + VC_STATE, rd16(ctx + VC_STATE) | bits); }
static void state_clear(uint32_t ctx, unsigned bits) { wr16(ctx + VC_STATE, rd16(ctx + VC_STATE) & ~bits); }

void rt_set_vi_hz(uint32_t hz) { vi_hz = hz == RT_VI_HZ_NTSC ? RT_VI_HZ_NTSC : RT_VI_HZ_PAL; }
uint32_t rt_vi_hz(void) { return vi_hz; }

void vi_reset(void) {
  next_retrace = 0;
  retraces = 0;
  since_notice = 0;
}

// At the retrace the pending edits take effect and the game's retrace queue is notified.
void te_vi_retrace(uint32_t a, uint32_t b) {
  (void)a; (void)b;
  uint32_t c = cur(), n = nxt();
  unsigned st = rd16(n + VC_STATE);
  if (st & VS_FRAMEBUFFER) wr32(c + VC_FRAMEBUFFER, rd32(n + VC_FRAMEBUFFER));
  if (st & VS_MODE) {
    wr32(c + VC_MODE, rd32(n + VC_MODE));
    wr32(c + VC_CONTROL, rd32(n + VC_CONTROL));
  }
  if (st & VS_FEATURES) wr32(c + VC_CONTROL, rd32(n + VC_CONTROL));
  if (st & VS_YSCALE) wr32(c + VC_YSCALE, rd32(n + VC_YSCALE));
  if (st & VS_XSCALE) wr32(c + VC_XSCALE, rd32(n + VC_XSCALE));
  wr16(c + VC_STATE, (rd16(c + VC_STATE) & ~VS_BLACK) | (st & VS_BLACK));
  state_clear(n, VS_FRAMEBUFFER | VS_MODE | VS_FEATURES | VS_YSCALE | VS_XSCALE);
  retraces++;
  if (++since_notice >= (rd16(n + VC_RETRACE) ? rd16(n + VC_RETRACE) : 1u)) {
    since_notice = 0;
    mq_try_send(rd32(n + VC_QUEUE), rd32(n + VC_MESSAGE));
  }
  next_retrace += RT_CPU_COUNTER / vi_hz;
  rt_schedule(next_retrace, TE_VI_RETRACE, 0, 0);
}

void rt_osCreateViManager(Cpu *c) {
  (void)c;
  if (rd32(OS_VI_ACTIVE)) return;
  wr32(OS_VI_ACTIVE, 1);
  for (uint32_t k = 0; k < 2 * VI_CONTEXT_SIZE; k += 4) wr32(OS_VI_CONTEXTS + k, 0);
  wr32(OS_VI_CURRENT, OS_VI_CONTEXTS);
  wr32(OS_VI_NEXT, OS_VI_CONTEXTS + VI_CONTEXT_SIZE);
  wr16(OS_VI_CONTEXTS + VC_STATE, VS_MODE);
  wr16(OS_VI_CONTEXTS + VI_CONTEXT_SIZE + VC_STATE, VS_MODE);
  next_retrace = rt_clock() + RT_CPU_COUNTER / vi_hz;
  rt_schedule(next_retrace, TE_VI_RETRACE, 0, 0);
}

void rt_osViSetMode(Cpu *c) {
  uint32_t n = nxt(), mode = ARG(0);
  wr32(n + VC_MODE, mode);
  wr16(n + VC_STATE, VS_MODE);
  wr32(n + VC_CONTROL, rd32(mode + 4));
}

void rt_osViSwapBuffer(Cpu *c) {
  uint32_t n = nxt();
  wr32(n + VC_FRAMEBUFFER, ARG(0));
  state_or(n, VS_FRAMEBUFFER);
}

void rt_osViBlack(Cpu *c) {
  if (ARG(0)) state_or(nxt(), VS_BLACK);
  else state_clear(nxt(), VS_BLACK);
}

// Argument is a float, passed in $f12.
void rt_osViSetXScale(Cpu *c) {
  uint32_t n = nxt();
  wr32(n + VC_XSCALE, fpr_w(c, 12));
  state_or(n, VS_XSCALE);
}

void rt_osViSetYScale(Cpu *c) {
  uint32_t n = nxt();
  wr32(n + VC_YSCALE, fpr_w(c, 12));
  state_or(n, VS_YSCALE);
}

// Feature bits of osViSetSpecialFeatures as they edit the control word: 0x1/0x2 gamma on/off (bit 3),
// 0x4/0x8 (bit 2), 0x10/0x20 (bit 4), 0x40 sets bit 16 and clears bits 8-9, 0x80 clears bit 16 and takes bits 8-9
// from the mode.
void rt_osViSetSpecialFeatures(Cpu *c) {
  uint32_t n = nxt(), f = ARG(0), ctl = rd32(n + VC_CONTROL);
  if (f & 0x01) ctl |= 0x8;
  if (f & 0x02) ctl &= ~0x8u;
  if (f & 0x04) ctl |= 0x4;
  if (f & 0x08) ctl &= ~0x4u;
  if (f & 0x10) ctl |= 0x10;
  if (f & 0x20) ctl &= ~0x10u;
  if (f & 0x40) ctl = (ctl | 0x10000u) & ~0x300u;
  if (f & 0x80) ctl = (ctl & ~0x10000u) | (rd32(rd32(n + VC_MODE) + 4) & 0x300u);
  wr32(n + VC_CONTROL, ctl);
  state_or(n, VS_FEATURES);
}

// osViSetEvent(queue, message, retrace count)
void rt_osViSetEvent(Cpu *c) {
  uint32_t n = nxt();
  wr32(n + VC_QUEUE, ARG(0));
  wr32(n + VC_MESSAGE, ARG(1));
  wr16(n + VC_RETRACE, (uint16_t)ARG(2));
}

void rt_osViGetNextFramebuffer(Cpu *c) { RET(rd32(nxt() + VC_FRAMEBUFFER)); }

void rt_osViGetCurrentFramebuffer(Cpu *c) {
  rt_poll(c, BS_VIGETFB, 16);
  RET(rd32(cur() + VC_FRAMEBUFFER));
}

void rt_vi_get(RtVi *out) {
  uint32_t c = rd32(OS_VI_CURRENT);
  out->framebuffer = c ? rd32(c + VC_FRAMEBUFFER) : 0;
  out->mode = c ? rd32(c + VC_MODE) : 0;
  out->black = c ? (rd16(c + VC_STATE) & VS_BLACK) != 0 : 0;
  out->retraces = retraces;
}

// ---- Saved state -------------------------------------------------------------------------------------------
// The contexts themselves are in RDRAM.

int vi_save(Writer *w) {
  put64(w, next_retrace);
  put32(w, retraces);
  put32(w, since_notice);
  return 1;
}

int vi_load(Reader *r, int apply) {
  uint64_t next = get64(r);
  uint32_t n = get32(r), since = get32(r);
  if (r->bad) return rt_state_refuse("the video interface state is damaged");
  if (apply) {
    next_retrace = next;
    retraces = n;
    since_notice = since;
  }
  return 1;
}
