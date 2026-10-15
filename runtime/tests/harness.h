// Minimal unit-test harness for the runtime: tests register themselves, run in sequence in one process and
// report one PASS or FAIL line each.
#ifndef OOT_TEST_HARNESS_H
#define OOT_TEST_HARNESS_H

#include <setjmp.h>
#include <stdio.h>
#include "../rt.h"

typedef void (*TestFn)(void);
void test_register(const char *name, TestFn fn);
void test_fail(const char *file, int line, const char *fmt, ...) __attribute__((format(printf, 3, 4)));

#define TEST(name)                                                              \
  static void name(void);                                                       \
  __attribute__((constructor)) static void register_##name(void) { test_register(#name, name); } \
  static void name(void)

#define CHECK(cond) do { if (!(cond)) test_fail(__FILE__, __LINE__, "%s", #cond); } while (0)
#define CHECK_EQ(actual, expected) do {                                                           \
    long long a_ = (long long)(actual), e_ = (long long)(expected);                                \
    if (a_ != e_) test_fail(__FILE__, __LINE__, "%s: got %lld (0x%llx), expected %lld (0x%llx)", #actual, a_, a_, e_, e_); \
  } while (0)
#define CHECK_STR(actual, expected) do {                                                          \
    const char *a_ = (actual), *e_ = (expected);                                                   \
    if (strcmp(a_, e_) != 0) test_fail(__FILE__, __LINE__, "%s: got \"%s\", expected \"%s\"", #actual, a_, e_); \
  } while (0)

// Resets the runtime, guest memory and the generated-code stand-ins to a clean state.
void fresh(void);

// ---- Calling OS replacements the way generated code does -------------------------------------------------------

static inline uint32_t os(Cpu *c, void (*fn)(Cpu *), uint32_t a0, uint32_t a1, uint32_t a2, uint32_t a3) {
  c->r[4] = SX32(a0);
  c->r[5] = SX32(a1);
  c->r[6] = SX32(a2);
  c->r[7] = SX32(a3);
  fn(c);
  return (uint32_t)c->r[2];
}
static inline void sarg(Cpu *c, int n, uint32_t v) { wr32((uint32_t)c->r[29] + 16 + 4 * (n - 4), v); }

// The context of the test itself, which runs outside every guest thread.
extern Cpu host;

// ---- Guest code ----------------------------------------------------------------------------------------------

// Registers `fn` as the recompiled function at `addr` of the main image.
void guest(uint32_t addr, GuestFn fn);
// Overlay images 1 and 2 link at 0x80900000 and 0x80908000 and are 0x8000 bytes long.
#define OVERLAY_LINK(k) (0x80900000u + 0x8000u * ((k) - 1))
void guest_overlay(int k, uint32_t link_offset, GuestFn fn);

// ---- Threads --------------------------------------------------------------------------------------------------

#define THREAD_ADDR(i) (0x80300000u + 0x200u * (i))
#define STACK_TOP(i) (0x80400000u + 0x2000u * (i) - 0x100u)
// osCreateThread for thread record `i` with the given entry, argument and priority.
uint32_t mk_thread(Cpu *c, int i, uint32_t entry, uint32_t arg, int pri);
uint32_t mk_queue(Cpu *c, uint32_t addr, uint32_t slots);

// ---- Log ------------------------------------------------------------------------------------------------------

void tlog(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
const char *tlog_get(void);

// Runs `body` and checks that it raised a fatal error containing `expected_substring`.
#define EXPECT_FATAL(body, expected_substring) do {                      \
    if (setjmp(fatal_jmp) == 0) { fatal_armed = 1; body; fatal_armed = 0; test_fail(__FILE__, __LINE__, "no fatal error from %s", #body); } \
    else { fatal_armed = 0; if (!strstr(fatal_message, expected_substring)) test_fail(__FILE__, __LINE__, "fatal \"%s\" lacks \"%s\"", fatal_message, expected_substring); } \
  } while (0)
extern jmp_buf fatal_jmp;
extern int fatal_armed;
extern char fatal_message[256];

#endif
