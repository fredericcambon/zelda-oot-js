#include <stdarg.h>
#include <stdlib.h>
#include "harness.h"

#define MAX_TESTS 256
static struct { const char *name; TestFn fn; } tests[MAX_TESTS];
static int test_n;
static int failed;
static char failure[512];

Cpu host;
jmp_buf fatal_jmp;
int fatal_armed;
char fatal_message[256];

void test_register(const char *name, TestFn fn) {
  tests[test_n].name = name;
  tests[test_n].fn = fn;
  test_n++;
}

void test_fail(const char *file, int line, const char *fmt, ...) {
  char text[400];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(text, sizeof text, fmt, ap);
  va_end(ap);
  if (!failed) snprintf(failure, sizeof failure, "%s:%d: %s", file, line, text);
  failed = 1;
}

// ---- Log ----------------------------------------------------------------------------------------------------

static char log_buf[2048];

void tlog(const char *fmt, ...) {
  size_t n = strlen(log_buf);
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(log_buf + n, sizeof log_buf - n, fmt, ap);
  va_end(ap);
}

const char *tlog_get(void) { return log_buf; }

// ---- Stand-ins for the generated code -------------------------------------------------------------------------

#define MAX_FNS 64
typedef struct Table {
  DispatchEntry e[MAX_FNS];
  uint32_t n;
} Table;
static Table main_table, overlay_table[2];

ImageInfo oot_images[3] = {
  { "main", 0x80100000u, 0x80200000u, 0, 0, 1, main_table.e, 0, 0, 0 },
  { "ovl1", 0x80900000u, 0x80908000u, 1, 0, 0, overlay_table[0].e, 0, 0, 0 },
  { "ovl2", 0x80908000u, 0x80910000u, 1, 0, 0, overlay_table[1].e, 0, 0, 0 },
};
const uint32_t oot_image_count = 3;

static void table_add(Table *t, ImageInfo *im, uint32_t addr, GuestFn fn) {
  uint32_t k = t->n++;
  while (k > 0 && t->e[k - 1].addr > addr) { t->e[k] = t->e[k - 1]; k--; }
  t->e[k] = (DispatchEntry){ addr, fn };
  im->count = t->n;
}

void guest(uint32_t addr, GuestFn fn) { table_add(&main_table, &oot_images[0], addr, fn); }
void guest_overlay(int k, uint32_t link_offset, GuestFn fn) {
  table_add(&overlay_table[k - 1], &oot_images[k], OVERLAY_LINK(k) + link_offset, fn);
}

// ---- Fresh state -----------------------------------------------------------------------------------------------

static void on_fatal(const char *message) {
  snprintf(fatal_message, sizeof fatal_message, "%s", message);
  if (fatal_armed) longjmp(fatal_jmp, 1);
  test_fail(__FILE__, __LINE__, "unexpected fatal error: %s", message);
  printf("FAIL fatal %s\n", message);
  fflush(stdout);
  abort();
}

void fresh(void) {
  memset(rdram, 0, RDRAM_SIZE);
  rt_reset();
  rt_set_fatal_handler(on_fatal);
  rt_set_gfx_hook(NULL);
  rt_set_audio_hook(NULL);
  rt_set_ai_hook(NULL);
  rt_ai_set_rate(32000);
  rt_rom_set(NULL, 0);
  log_buf[0] = 0;
  main_table.n = overlay_table[0].n = overlay_table[1].n = 0;
  oot_images[0].site_count = oot_site_count;
  for (int k = 0; k < 3; k++) {
    oot_images[k].count = 0;
    oot_images[k].delta = 0;
    oot_images[k].loaded = k == 0;
  }
  // The boot image's initialised data: the empty-list node and the heads that point at it.
  wr32(OS_SENTINEL + TH_PRI, 0xffffffffu);
  wr32(OS_SENTINEL + TH_NEXT, 0);
  wr32(OS_SENTINEL + TH_QUEUE, OS_SENTINEL);
  wr32(OS_SENTINEL + TH_TLNEXT, OS_SENTINEL);
  wr32(OS_RUNQUEUE, OS_SENTINEL);
  wr32(OS_ALLTHREADS, OS_SENTINEL);
  wr32(OS_RUNNING, 0);
  memset(&host, 0, sizeof host);
  host.r[29] = SX32(0x80700000u);
}

uint32_t mk_thread(Cpu *c, int i, uint32_t entry, uint32_t arg, int pri) {
  sarg(c, 4, STACK_TOP(i));
  sarg(c, 5, (uint32_t)pri);
  os(c, rt_osCreateThread, THREAD_ADDR(i), 100 + i, entry, arg);
  return THREAD_ADDR(i);
}

uint32_t mk_queue(Cpu *c, uint32_t addr, uint32_t slots) {
  os(c, rt_osCreateMesgQueue, addr, addr + 0x20, slots, 0);
  return addr;
}

// ---- Runner -----------------------------------------------------------------------------------------------------

int main(void) {
  int bad = 0;
  for (int k = 0; k < test_n; k++) {
    failed = 0;
    failure[0] = 0;
    fresh();
    tests[k].fn();
    if (failed) { printf("FAIL %s %s\n", tests[k].name, failure); bad++; }
    else printf("PASS %s\n", tests[k].name);
    fflush(stdout);
  }
  return bad ? 1 : 0;
}
