// The portable save state: the game's state as build-independent data. RDRAM, the registers of the guest, the
// call chains of the threads in terms of the ROM's functions, and the variables of the runtime and its devices;
// no host address, no heap and no memory of the wasm module (docs/runtime.md, "Portable save states").
#include <stdarg.h>
#include <stdio.h>
#include "rt.h"

#define STATE_MAGIC 0x50544f4fu     // "OOTP"
#define OLD_STATE_MAGIC 0x4f4f5453u // the raw memory dump of the earlier format, whose first word is written big-endian
#define TAG(a, b, c, d) ((uint32_t)(a) | (uint32_t)(b) << 8 | (uint32_t)(c) << 16 | (uint32_t)(d) << 24)

// ---- Refusals ----------------------------------------------------------------------------------------------

static char state_error[256];

const char *rt_state_error(void) { return state_error; }
void rt_state_clear(void) { state_error[0] = 0; }

int rt_state_refuse(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(state_error, sizeof state_error, fmt, ap);
  va_end(ap);
  return 0;
}

// ---- Words -------------------------------------------------------------------------------------------------

void put32(Writer *w, uint32_t v) {
  if (w->buf && w->len + 4 <= w->cap) memcpy(w->buf + w->len, &v, 4);
  w->len += 4;
}

void put64(Writer *w, uint64_t v) {
  put32(w, (uint32_t)v);
  put32(w, (uint32_t)(v >> 32));
}

uint32_t get32(Reader *r) {
  uint32_t v = 0;
  if (r->pos + 4 > r->len) { r->bad = 1; return 0; }
  memcpy(&v, r->buf + r->pos, 4);
  r->pos += 4;
  return v;
}

uint64_t get64(Reader *r) {
  uint64_t lo = get32(r);
  return lo | (uint64_t)get32(r) << 32;
}

// ---- Sections ----------------------------------------------------------------------------------------------

typedef struct Section {
  uint32_t tag;
  const char *name;
  int (*save)(Writer *w);
  int (*load)(Reader *r, int apply);
} Section;

static int rdram_save(Writer *w) {
  if (w->buf && w->len + RDRAM_SIZE <= w->cap) memcpy(w->buf + w->len, rdram, RDRAM_SIZE);
  w->len += RDRAM_SIZE;
  return 1;
}

static int rdram_load(Reader *r, int apply) {
  if (r->len != RDRAM_SIZE) return rt_state_refuse("the RDRAM of the state has %u bytes, not %u", r->len, RDRAM_SIZE);
  if (apply) memcpy(rdram, r->buf, RDRAM_SIZE);
  r->pos = r->len;
  return 1;
}

static int threads_save(Writer *w) {
  uint32_t n = rt_threads_describe(NULL, 0);
  if (n == 0) return 0;
  if (w->buf && w->len + n <= w->cap && rt_threads_describe(w->buf + w->len, w->cap - w->len) != n) return 0;
  w->len += n;
  return 1;
}

static int threads_load(Reader *r, int apply) {
  r->pos = r->len;
  return apply ? rt_threads_rebuild(r->buf, r->len) : rt_threads_check(r->buf, r->len);
}

// The frame counters belong to the headless host; a build without it (the unit tests) has no such section.
extern int headless_save(Writer *w) __attribute__((weak));
extern int headless_load(Reader *r, int apply) __attribute__((weak));

static int frames_save(Writer *w) { return headless_save(w); }
static int frames_load(Reader *r, int apply) { return headless_load(r, apply); }

// The order in which sections are written. The threads are applied last, whatever their place: rebuilding them
// takes the rest of the state as it is to be.
static const Section sections[] = {
  { TAG('R', 'D', 'R', 'M'), "RDRAM", rdram_save, rdram_load },
  { TAG('C', 'O', 'P', '0'), "COP0", dispatch_save, dispatch_load },
  { TAG('O', 'V', 'L', 'Y'), "overlays", overlays_save, overlays_load },
  { TAG('T', 'H', 'R', 'D'), "threads", threads_save, threads_load },
  { TAG('C', 'L', 'C', 'K'), "clock", clock_save, clock_load },
  { TAG('C', 'O', 'N', 'T'), "controllers", cont_save, cont_load },
  { TAG('P', 'I', ' ', ' '), "cartridge interface", pi_save, pi_load },
  { TAG('V', 'I', ' ', ' '), "video interface", vi_save, vi_load },
  { TAG('A', 'U', 'D', 'O'), "audio interface", rsp_save, rsp_load },
  { TAG('J', 'P', 'E', 'G'), "JPEG decoder", jpeg_save, jpeg_load },
  { TAG('F', 'R', 'M', 'S'), "frame counters", frames_save, frames_load },
};
#define SECTION_COUNT (sizeof sections / sizeof sections[0])
#define THREADS_SECTION 3

static int present(size_t k) { return sections[k].save != frames_save || headless_save != NULL; }

uint32_t rt_state_save(uint8_t *buf, uint32_t cap) {
  rt_state_clear();
  Writer w = { buf, cap, 0 };
  uint32_t count = 0;
  for (size_t k = 0; k < SECTION_COUNT; k++) count += present(k);
  put32(&w, STATE_MAGIC);
  put32(&w, RT_STATE_VERSION);
  put32(&w, count);
  for (size_t k = 0; k < SECTION_COUNT; k++) {
    if (!present(k)) continue;
    put32(&w, sections[k].tag);
    uint32_t length_at = w.len;
    put32(&w, 0);
    uint32_t start = w.len;
    if (!sections[k].save(&w)) return 0;
    if (buf && length_at + 4 <= cap) {
      uint32_t length = w.len - start;
      memcpy(buf + length_at, &length, 4);
    }
  }
  if (buf && w.len > cap) return (uint32_t)rt_state_refuse("the buffer holds %u bytes and the state needs %u", cap, w.len);
  return w.len;
}

int rt_state_load(const uint8_t *buf, uint32_t len) {
  rt_state_clear();
  Reader r = { buf, len, 0, 0 };
  uint32_t magic = get32(&r), version = get32(&r), count = get32(&r);
  if (r.bad) return rt_state_refuse("this is not a saved game state");
  if (__builtin_bswap32(magic) == OLD_STATE_MAGIC) return rt_state_refuse("this state was saved in the old format, which cannot be loaded");
  if (magic != STATE_MAGIC) return rt_state_refuse("this is not a saved game state");
  if (version != RT_STATE_VERSION) return rt_state_refuse("this state uses format %u, this build reads %u", version, RT_STATE_VERSION);

  Reader found[SECTION_COUNT];
  int seen[SECTION_COUNT] = { 0 };
  for (uint32_t j = 0; j < count; j++) {
    uint32_t tag = get32(&r), length = get32(&r);
    if (r.bad || length > len - r.pos) return rt_state_refuse("the state is cut short");
    size_t k = 0;
    while (k < SECTION_COUNT && (sections[k].tag != tag || !present(k))) k++;
    if (k == SECTION_COUNT) return rt_state_refuse("the state has a section %c%c%c%c that this build does not know", (char)tag, (char)(tag >> 8), (char)(tag >> 16), (char)(tag >> 24));
    if (seen[k]) return rt_state_refuse("the state has two %s sections", sections[k].name);
    seen[k] = 1;
    found[k] = (Reader){ buf + r.pos, length, 0, 0 };
    r.pos += length;
  }
  if (r.pos != len) return rt_state_refuse("the state has data after its last section");
  for (size_t k = 0; k < SECTION_COUNT; k++) {
    if (present(k) && !seen[k]) return rt_state_refuse("the state lacks its %s section", sections[k].name);
  }

  for (size_t k = 0; k < SECTION_COUNT; k++) {
    if (!present(k)) continue;
    Reader sec = found[k];
    if (!sections[k].load(&sec, 0)) return 0;
    if (sec.pos != sec.len) return rt_state_refuse("the %s section of the state has %u bytes too many", sections[k].name, sec.len - sec.pos);
  }
  for (size_t k = 0; k < SECTION_COUNT; k++) {
    if (!present(k) || k == THREADS_SECTION) continue;
    Reader sec = found[k];
    sections[k].load(&sec, 1);
  }
  Reader sec = found[THREADS_SECTION];
  return sections[THREADS_SECTION].load(&sec, 1);
}
