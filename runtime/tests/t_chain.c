// Shadow stack, resume mode and rebuilding the threads of a described state.
//
// The functions below are shaped like the recompiler's output: they push their call site before a call and pop
// it after, and carry the entry that re-issues a call when they are re-entered in resume mode.
#include <stdlib.h>
#include "harness.h"

#define BOOT 0x80100000u
#define ENT_A 0x80100200u
#define ENT_B 0x80100300u
#define ENT_C 0x80100400u
#define ENT_D 0x80100500u
#define ENT_G 0x80100600u
#define QUEUE_A 0x80500000u
#define MSG_OUT 0x80500800u
#define BITS_OUT 0x80540000u
#define STATUS_OUT 0x80540100u
#define BIG_STACK 0x80600000u

static void f_outer(Cpu *c);
static void f_inner(Cpu *c);
static void f_sender(Cpu *c);
static void f_loader(Cpu *c);
static void f_loader_inner(Cpu *c);
static void f_sleeper(Cpu *c);
static void f_reader(Cpu *c);
static void g_a(Cpu *c);
static void g_b(Cpu *c);
static void g_c(Cpu *c);

// The call sites, by key: 0 and 1 in f_outer (a direct and an indirect call), 2 in f_inner (the blocking call),
// 3 and 9 in f_sender, 10 in f_reader, 4 in f_loader (the overlay loader), 5 in f_loader_inner, 6 in f_sleeper, 7 and 8 in g_a and g_b.
const SiteEntry oot_sites[] = {
  { f_outer, ENT_A, ENT_A + 0x10 },
  { f_outer, ENT_A, ENT_A + 0x20 },
  { f_inner, ENT_B, ENT_B + 0x08 },
  { f_sender, ENT_D, ENT_D + 0x04 },
  { f_loader, ENT_C, ENT_C + 0x04 },
  { f_loader_inner, 0x80100700u, 0x80100704u },
  { f_sleeper, 0x80100800u, 0x80100804u },
  { g_a, ENT_G, ENT_G + 0x04 },
  { g_b, ENT_G + 0x100, ENT_G + 0x104 },
  { f_sender, ENT_D, ENT_D + 0x08 },
  { f_reader, 0x80100900u, 0x80100904u },
};
const uint32_t oot_site_count = sizeof oot_sites / sizeof oot_sites[0];

// f_outer: a direct call to f_inner, then an indirect call to the function at ENT_B (f_inner again).
static void f_outer(Cpu *c) {
  if (OOT_RESUMING()) goto resume_entry;
  tlog("o1 ");
  OOT_PUSH(0); f_inner(c); D_0:; OOT_POP();
  tlog("o2 ");
  OOT_PUSH(1); rt_call(c, ENT_B); D_1:; OOT_POP();
  tlog("o3 ");
  return;
resume_entry:
  switch (OOT_RESUME_SITE()) {
    case 0: goto Q_0;
    case 1: goto Q_1;
    default: rt_resume_bad(c);
  }
Q_0: rt_resume_call(c, f_inner); goto D_0;
Q_1: rt_call(c, 0); goto D_1;
}

// f_inner: waits for a message and logs it.
static void f_inner(Cpu *c) {
  if (OOT_RESUMING()) goto resume_entry;
  tlog("i1 ");
  OOT_PUSH(2); os(c, rt_osRecvMesg, QUEUE_A, MSG_OUT, OS_MESG_BLOCK, 0); D_2:; OOT_POP();
  tlog("i2(%x) ", rd32(MSG_OUT));
  return;
resume_entry:
  switch (OOT_RESUME_SITE()) {
    case 2: goto Q_2;
    default: rt_resume_bad(c);
  }
Q_2: rt_resume_call(c, rt_osRecvMesg); goto D_2;
}

// f_sender: starts a thread of higher priority that waits for a message, then sends one.
static void f_sender(Cpu *c) {
  if (OOT_RESUMING()) goto resume_entry;
  tlog("s1 ");
  mk_thread(c, 1, ENT_B, 0, 10);
  OOT_PUSH(3); os(c, rt_osStartThread, THREAD_ADDR(1), 0, 0, 0); D_3:; OOT_POP();
  OOT_PUSH(9); os(c, rt_osSendMesg, QUEUE_A, 0x77, OS_MESG_BLOCK, 0); D_9:; OOT_POP();
  tlog("s2 ");
  return;
resume_entry:
  switch (OOT_RESUME_SITE()) {
    case 3: goto Q_3;
    case 9: goto Q_9;
    default: rt_resume_bad(c);
  }
Q_3: rt_resume_call(c, rt_osStartThread); goto D_3;
Q_9: rt_resume_call(c, rt_osSendMesg); goto D_9;
}

// The recompiled overlay loader calls this when it is set: the loader's own call sites are not part of the stand-in.
extern void (*loader_hook)(Cpu *c);

static void f_loader(Cpu *c) {
  if (OOT_RESUMING()) goto resume_entry;
  tlog("l1 ");
  c->r[6] = SX32(OVERLAY_LINK(1));
  wr32((uint32_t)c->r[29] + 16, 0x80700000u);
  OOT_PUSH(4); rt_overlay_load(c); D_4:; OOT_POP();
  tlog("l2 ");
  return;
resume_entry:
  switch (OOT_RESUME_SITE()) {
    case 4: goto Q_4;
    default: rt_resume_bad(c);
  }
Q_4: rt_resume_call(c, rt_overlay_load); goto D_4;
}

// Runs inside the loader and blocks; the registers it sets for the receive are not the loader's arguments.
static void f_loader_inner(Cpu *c) {
  if (OOT_RESUMING()) goto resume_entry;
  OOT_PUSH(5); os(c, rt_osRecvMesg, QUEUE_A, MSG_OUT, OS_MESG_BLOCK, 0); D_5:; OOT_POP();
  tlog("li(%x) ", rd32(MSG_OUT));
  return;
resume_entry:
  switch (OOT_RESUME_SITE()) {
    case 5: goto Q_5;
    default: rt_resume_bad(c);
  }
Q_5: rt_resume_call(c, rt_osRecvMesg); goto D_5;
}

static void f_sleeper(Cpu *c) {
  if (OOT_RESUMING()) goto resume_entry;
  OOT_PUSH(6); os(c, rt_osContInit, QUEUE_A, BITS_OUT, STATUS_OUT, 0); D_6:; OOT_POP();
  tlog("slept@%u bits=%x ", (unsigned)(rt_clock() >= RT_CPU_COUNTER / 2), rd8(BITS_OUT));
  return;
resume_entry:
  switch (OOT_RESUME_SITE()) {
    case 6: goto Q_6;
    default: rt_resume_bad(c);
  }
Q_6: rt_resume_call(c, rt_osContInit); goto D_6;
}

// A chain of plain calls that reports the shadow stack at its end.
static void g_a(Cpu *c) {
  if (OOT_RESUMING()) goto resume_entry;
  OOT_PUSH(7); g_b(c); D_7:; OOT_POP();
  tlog("depth=%u ", c->shn);
  return;
resume_entry:
  rt_resume_bad(c);
  goto D_7;
}

static void g_b(Cpu *c) {
  if (OOT_RESUMING()) goto resume_entry;
  OOT_PUSH(8); g_c(c); D_8:; OOT_POP();
  return;
resume_entry:
  rt_resume_bad(c);
  goto D_8;
}

static void g_c(Cpu *c) { tlog("keys=%u,%u depth=%u ", c->sh[0], c->sh[1], c->shn); }

// ---- Scenarios ---------------------------------------------------------------------------------------------

static uint32_t entry_a;
static int pri_a;

// The boot code creates the queue and starts the first thread, after which it is abandoned.
static void boot_threads(Cpu *c) {
  mk_queue(c, QUEUE_A, 4);
  mk_thread(c, 0, entry_a, 0, pri_a);
  os(c, rt_osStartThread, THREAD_ADDR(0), 0, 0, 0);
}

static void scenario(uint32_t a, int pa) {
  entry_a = a;
  pri_a = pa;
  guest(BOOT, boot_threads);
  guest(ENT_A, f_outer);
  guest(ENT_B, f_inner);
  guest(ENT_C, f_loader);
  guest(ENT_D, f_sender);
  guest(ENT_G, g_a);
  guest(0x80100800u, f_sleeper);
  rt_start(BOOT, BIG_STACK);
}

static uint8_t desc[8192];

static uint32_t describe(void) {
  uint32_t n = rt_threads_describe(NULL, 0);
  CHECK(n > 0 && n <= sizeof desc);
  CHECK_EQ(rt_threads_describe(desc, sizeof desc), n);
  return n;
}

static uint32_t word(uint32_t at) {
  uint32_t v;
  memcpy(&v, desc + at, 4);
  return v;
}

// Where the first thread record starts in a description, and the size of the context it holds before its frames.
#define DESC_HEADER 20u
#define DESC_CPU (4u * (2 * 32 + 2 * 2 + 1 + 2 * 32 + 3))
#define DESC_THREAD_HEAD (16u + DESC_CPU + 8u)

// Replaces the threads with those of the description, as a fresh instance would.
static void rebuild(uint32_t n) {
  CHECK(rt_threads_rebuild(desc, n));
  CHECK_STR(rt_state_error(), "");
}

TEST(calls_push_their_sites_and_returns_pop_them) {
  scenario(ENT_G, 10);
  CHECK_EQ(rt_run(100000), RT_RUN_IDLE);
  CHECK_STR(tlog_get(), "keys=7,8 depth=2 depth=0 ");
}

TEST(a_call_chain_deeper_than_the_shadow_stack_stops_the_game) {
  host.shn = OOT_SH_MAX;
  Cpu *c = &host;
  EXPECT_FATAL(OOT_PUSH(1), "deeper than");
  host.shn = 0;
}

static void blocked_chain_scenario(void) {
  scenario(ENT_A, 10);
  CHECK_EQ(rt_run(100000), RT_RUN_IDLE);
  CHECK_STR(tlog_get(), "o1 i1 ");
}

TEST(a_blocked_thread_is_described_by_the_functions_and_sites_of_its_chain) {
  blocked_chain_scenario();
  uint32_t n = describe();
  CHECK_EQ(word(0), 0x44524854u);
  CHECK_EQ(word(4), 1);
  CHECK_EQ(word(8), 0);
  uint32_t t = DESC_HEADER;
  CHECK_EQ(word(t + 4), THREAD_ADDR(0));
  CHECK_EQ(word(t + 8), ENT_A);
  CHECK_EQ(word(t + 12), 1);
  CHECK_EQ(word(t + DESC_THREAD_HEAD - 8), BS_RECV_WAIT);
  CHECK_EQ(word(t + DESC_THREAD_HEAD - 4), 2);
  uint32_t f = t + DESC_THREAD_HEAD;
  CHECK_EQ(word(f), 0);
  CHECK_EQ(word(f + 8), ENT_A);
  CHECK_EQ(word(f + 12), ENT_A + 0x10);
  CHECK_EQ(word(f + 16), 0);
  CHECK_EQ(word(f + 24), ENT_B);
  CHECK_EQ(word(f + 28), ENT_B + 0x08);
  CHECK_EQ(n, f + 32);
}

// Runs a scenario to its first block, then completes it with messages, optionally rebuilding the threads each time.
static const char *two_messages(int rebuild_between) {
  blocked_chain_scenario();
  for (int round = 1; round <= 2; round++) {
    if (rebuild_between) rebuild(describe());
    CHECK(mq_try_send(QUEUE_A, 0x10u * round));
    CHECK_EQ(rt_run(1000000), RT_RUN_IDLE);
  }
  return tlog_get();
}

TEST(rebuilt_threads_continue_through_direct_and_indirect_call_sites) {
  static char control[256];
  snprintf(control, sizeof control, "%s", two_messages(0));
  CHECK_STR(control, "o1 i1 i2(10) o2 i1 i2(20) o3 ");
  fresh();
  CHECK_STR(two_messages(1), control);
  CHECK_EQ(rd32(OS_ALLTHREADS), OS_SENTINEL);
}

TEST(rebuilding_gives_the_thread_a_new_fiber_and_leaves_the_rest_of_the_state_alone) {
  blocked_chain_scenario();
  uint32_t n = describe();
  uint32_t state = rd16(THREAD_ADDR(0) + TH_STATE), queue = rd32(THREAD_ADDR(0) + TH_QUEUE);
  uint64_t now = rt_clock();
  rebuild(n);
  CHECK_EQ(rd16(THREAD_ADDR(0) + TH_STATE), state);
  CHECK_EQ(rd32(THREAD_ADDR(0) + TH_QUEUE), queue);
  CHECK_EQ(rt_clock(), now);
  CHECK_STR(tlog_get(), "o1 i1 ");
  uint8_t again[sizeof desc];
  memcpy(again, desc, n);
  CHECK_EQ(rt_threads_describe(desc, sizeof desc), n);
  CHECK(memcmp(again, desc, n) == 0);
}

// Thread 0 (priority 5) starts thread 1 (priority 10), which waits for a message. Starting it preempts thread 0 inside
// osStartThread, and the message thread 0 then sends makes thread 1 runnable and preempts it again inside osSendMesg.
// The run stops there, with thread 0 preempted and thread 1 runnable.
static const char *preempted_sender(int rebuild_at_boundary) {
  scenario(ENT_D, 5);
  CHECK_EQ(rt_run(2000), RT_RUN_TIME);
  if (rebuild_at_boundary) rebuild(describe());
  CHECK_EQ(rt_run(1000000), RT_RUN_IDLE);
  return tlog_get();
}

TEST(a_thread_preempted_in_a_send_is_rebuilt_with_the_run_queue_as_it_was) {
  static char control[256];
  snprintf(control, sizeof control, "%s", preempted_sender(0));
  CHECK_STR(control, "s1 i1 i2(77) s2 ");
  fresh();
  CHECK_STR(preempted_sender(1), control);
  fresh();
  scenario(ENT_D, 5);
  CHECK_EQ(rt_run(2000), RT_RUN_TIME);
  describe();
  CHECK_EQ(word(4), 2);
}

static void loader_waits(Cpu *c) { f_loader_inner(c); }

TEST(a_thread_blocked_inside_the_overlay_loader_keeps_the_loaders_arguments) {
  loader_hook = loader_waits;
  scenario(ENT_C, 10);
  CHECK_EQ(rt_run(100000), RT_RUN_IDLE);
  uint32_t n = describe();
  // The chain is the call into the loader, the loader's own frame with its two arguments, and the call inside.
  uint32_t f = DESC_HEADER + DESC_THREAD_HEAD;
  CHECK_EQ(word(DESC_HEADER + DESC_THREAD_HEAD - 4), 3);
  CHECK_EQ(word(f), 0);
  CHECK_EQ(word(f + 16), 1);
  CHECK_EQ(word(f + 20), RT_FRAME_OVERLAY_LOAD);
  CHECK_EQ(word(f + 24), OVERLAY_LINK(1));
  CHECK_EQ(word(f + 28), 0x80700000u);
  CHECK_EQ(word(f + 32), 0);
  CHECK_EQ(word(f + 40), 0x80100700u);
  CHECK_EQ(n, f + 48);
  rebuild(n);
  CHECK(mq_try_send(QUEUE_A, 0x5a));
  CHECK_EQ(rt_run(1000000), RT_RUN_IDLE);
  CHECK_STR(tlog_get(), "l1 loader li(5a) l2 ");
  CHECK(oot_images[1].loaded);
  CHECK_EQ(oot_images[1].delta, 0x80700000u - OVERLAY_LINK(1));
  loader_hook = NULL;
}

TEST(a_thread_sleeping_on_the_clock_is_rebuilt_and_wakes_on_time) {
  scenario(0x80100800u, 10);
  CHECK_EQ(rt_run(1000), RT_RUN_TIME);
  uint32_t n = describe();
  CHECK_EQ(word(DESC_HEADER + DESC_THREAD_HEAD - 8), BS_CONTINIT_SLEEP);
  rebuild(n);
  CHECK_EQ(rt_run(RT_CPU_COUNTER), RT_RUN_IDLE);
  CHECK_STR(tlog_get(), "slept@1 bits=1 ");
}

TEST(a_description_that_names_an_unknown_site_is_refused_and_the_threads_stay_as_they_are) {
  blocked_chain_scenario();
  uint32_t n = describe();
  uint32_t f = DESC_HEADER + DESC_THREAD_HEAD;
  uint32_t saved = word(f + 12);
  uint32_t bad = saved + 4;
  memcpy(desc + f + 12, &bad, 4);
  CHECK(!rt_threads_rebuild(desc, n));
  CHECK(strstr(rt_state_error(), "no call site") != NULL);
  memcpy(desc + f + 12, &saved, 4);
  CHECK(!rt_threads_rebuild(desc, n - 4));
  CHECK(strstr(rt_state_error(), "damaged") != NULL);
  desc[0] ^= 1;
  CHECK(!rt_threads_rebuild(desc, n));
  CHECK(strstr(rt_state_error(), "not one this build reads") != NULL);
  desc[0] ^= 1;
  // The refused descriptions changed nothing: the original thread still runs.
  CHECK(mq_try_send(QUEUE_A, 1));
  CHECK_EQ(rt_run(1000000), RT_RUN_IDLE);
  CHECK_STR(tlog_get(), "o1 i1 i2(1) o2 i1 ");
}

TEST(threads_are_not_described_while_the_game_boots) {
  scenario(ENT_A, 10);
  CHECK_EQ(rt_threads_describe(NULL, 0), 0);
  CHECK(strstr(rt_state_error(), "booting") != NULL);
}

TEST(a_buffer_that_is_too_small_is_refused) {
  blocked_chain_scenario();
  uint32_t n = describe();
  CHECK_EQ(rt_threads_describe(desc, n - 4), 0);
  CHECK(strstr(rt_state_error(), "buffer") != NULL);
}

// Starts a controller read: the routine waits for the first completion on the queue in a receive of its own.
static void f_reader(Cpu *c) {
  if (OOT_RESUMING()) goto resume_entry;
  OOT_PUSH(10); os(c, rt_osContStartReadData, QUEUE_A, 0, 0, 0); D_10:; OOT_POP();
  tlog("read(%u) ", c->shn);
  return;
resume_entry:
  switch (OOT_RESUME_SITE()) {
    case 10: goto Q_10;
    default: rt_resume_bad(c);
  }
Q_10: rt_resume_call(c, rt_osContStartReadData); goto D_10;
}

TEST(a_controller_read_waiting_for_the_serial_interface_is_rebuilt_with_its_frame) {
  scenario(0x80100900u, 10);
  guest(0x80100900u, f_reader);
  CHECK_EQ(rt_run(2000), RT_RUN_TIME);
  uint32_t n = describe();
  uint32_t f = DESC_HEADER + DESC_THREAD_HEAD;
  CHECK_EQ(word(DESC_HEADER + DESC_THREAD_HEAD - 8), BS_RECV_WAIT);
  CHECK_EQ(word(DESC_HEADER + DESC_THREAD_HEAD - 4), 2);
  CHECK_EQ(word(f + 16), 1);
  CHECK_EQ(word(f + 20), RT_FRAME_CONT_TRANSFER);
  CHECK_EQ(word(f + 24), QUEUE_A);
  CHECK_EQ(word(f + 28), 1);
  CHECK_EQ(n, f + 32);
  rebuild(n);
  CHECK_EQ(rt_run(RT_CPU_COUNTER), RT_RUN_IDLE);
  CHECK_STR(tlog_get(), "read(0) ");
}

// ---- Portable states -------------------------------------------------------------------------------------------

static uint8_t *state;
static uint32_t state_size;

static void save_state(void) {
  free(state);
  state_size = rt_state_save(NULL, 0);
  CHECK(state_size > RDRAM_SIZE);
  state = malloc(state_size);
  CHECK_EQ(rt_state_save(state, state_size), state_size);
}

// The offset of the payload of the section `tag` of the saved state.
static uint32_t section_at(const char *tag) {
  uint32_t at = 12;
  while (at + 8 <= state_size) {
    uint32_t length;
    memcpy(&length, state + at + 4, 4);
    if (memcmp(state + at, tag, 4) == 0) return at + 8;
    at += 8 + length;
  }
  return 0;
}

static void expect_refusal(const char *part) {
  CHECK(!rt_state_load(state, state_size));
  CHECK(strstr(rt_state_error(), part) != NULL);
  if (!strstr(rt_state_error(), part)) printf("  refusal was \"%s\"\n", rt_state_error());
}

// After a refusal the game goes on as before: the message the thread waits for completes its call.
static void game_continues(void) {
  CHECK(mq_try_send(QUEUE_A, 0x10));
  CHECK_EQ(rt_run(1000000), RT_RUN_IDLE);
  CHECK_STR(tlog_get(), "o1 i1 i2(10) o2 i1 ");
}

TEST(a_saved_state_loads_back_and_the_game_goes_on_as_it_did_from_the_save) {
  blocked_chain_scenario();
  save_state();
  CHECK(mq_try_send(QUEUE_A, 0x10));
  CHECK_EQ(rt_run(1000000), RT_RUN_IDLE);
  CHECK_STR(tlog_get(), "o1 i1 i2(10) o2 i1 ");
  uint64_t later = rt_clock();
  CHECK(rt_state_load(state, state_size));
  CHECK_STR(rt_state_error(), "");
  CHECK(rt_clock() <= later);
  CHECK_EQ(rd32(QUEUE_A + MQ_VALID), 0);
  // The log is the host's and keeps both runs: the second repeats the first from the save.
  CHECK(mq_try_send(QUEUE_A, 0x10));
  CHECK_EQ(rt_run(1000000), RT_RUN_IDLE);
  CHECK_STR(tlog_get(), "o1 i1 i2(10) o2 i1 i2(10) o2 i1 ");
}

TEST(a_state_is_not_saved_while_the_game_boots_and_the_game_then_runs_on) {
  scenario(ENT_A, 10);
  CHECK_EQ(rt_state_save(NULL, 0), 0);
  CHECK(strstr(rt_state_error(), "booting") != NULL);
  CHECK_EQ(rt_run(100000), RT_RUN_IDLE);
  CHECK_STR(tlog_get(), "o1 i1 ");
}

TEST(a_state_is_not_saved_with_a_host_event_queued) {
  blocked_chain_scenario();
  rt_schedule(rt_clock() + 100, TE_USER, 0, 0);
  CHECK_EQ(rt_state_save(NULL, 0), 0);
  CHECK(strstr(rt_state_error(), "host event") != NULL);
}

TEST(a_state_with_another_format_version_is_refused_with_both_versions_named) {
  blocked_chain_scenario();
  save_state();
  uint32_t other = RT_STATE_VERSION + 1;
  memcpy(state + 4, &other, 4);
  expect_refusal("uses format 2, this build reads 1");
  game_continues();
}

TEST(a_state_saved_at_another_retrace_rate_is_refused_and_one_without_a_rate_loads) {
  blocked_chain_scenario();
  save_state();
  rt_set_vi_hz(60);
  expect_refusal("saved at 50 Hz and this game runs at 60 Hz");
  rt_set_vi_hz(RT_VI_HZ_PAL);
  CHECK(rt_state_load(state, state_size));
  // Drop the trailing rate word from the video interface section, as an older state has it.
  uint32_t at = section_at("VI  ");
  uint32_t length;
  memcpy(&length, state + at - 4, 4);
  length -= 4;
  memcpy(state + at - 4, &length, 4);
  memmove(state + at + length, state + at + length + 4, state_size - (at + length + 4));
  state_size -= 4;
  rt_set_vi_hz(60);
  CHECK(rt_state_load(state, state_size));
  rt_set_vi_hz(RT_VI_HZ_PAL);
}

TEST(a_state_in_the_old_format_or_no_state_at_all_is_refused) {
  blocked_chain_scenario();
  save_state();
  memcpy(state, "OOTS", 4);
  expect_refusal("old format");
  memcpy(state, "junk", 4);
  expect_refusal("not a saved game state");
  state_size = 6;
  expect_refusal("not a saved game state");
  game_continues();
}

TEST(a_cut_short_or_padded_state_is_refused) {
  blocked_chain_scenario();
  save_state();
  uint32_t full = state_size;
  state_size = full - 1;
  expect_refusal("cut short");
  state_size = full - 4096;
  expect_refusal("cut short");
  state = realloc(state, full + 4);
  memset(state + full, 0, 4);
  state_size = full + 4;
  expect_refusal("after its last section");
  game_continues();
}

TEST(a_state_with_an_unknown_duplicate_or_missing_section_is_refused) {
  blocked_chain_scenario();
  save_state();
  uint32_t at = section_at("CLCK");
  CHECK(at != 0);
  memcpy(state + at - 8, "NEWS", 4);
  expect_refusal("section NEWS");
  memcpy(state + at - 8, "CLCK", 4);
  uint32_t cont_at = section_at("CONT");
  memcpy(state + cont_at - 8, "CLCK", 4);
  expect_refusal("two clock sections");
  memcpy(state + cont_at - 8, "CONT", 4);
  game_continues();
}

TEST(a_state_with_an_unknown_timed_event_kind_or_function_site_is_refused_and_nothing_changes) {
  blocked_chain_scenario();
  rt_schedule(rt_clock() + 100000, TE_RSP_EVENT, EVENT_VI, 0);
  save_state();
  uint32_t kind = 99, at = section_at("CLCK") + 8 + 4;
  memcpy(state + at, &kind, 4);
  expect_refusal("kind 99");
  kind = TE_RSP_EVENT;
  memcpy(state + at, &kind, 4);

  // A call site the build does not have: the thread section names the outermost function and call address.
  uint32_t site_at = section_at("THRD") + DESC_HEADER + DESC_THREAD_HEAD + 12;
  uint32_t site;
  memcpy(&site, state + site_at, 4);
  uint32_t bad = site + 4;
  memcpy(state + site_at, &bad, 4);
  wr32(0x80500400u, 0xdeadbeefu);
  expect_refusal("no call site");
  CHECK_EQ(rd32(0x80500400u), 0xdeadbeefu);
  memcpy(state + site_at, &site, 4);
  game_continues();
}

TEST(a_state_with_a_damaged_device_section_is_refused) {
  blocked_chain_scenario();
  save_state();
  uint32_t zero = 0;
  memcpy(state + section_at("AUDO") + 0, &zero, 4);
  expect_refusal("audio interface state is damaged");
  state_size = section_at("RDRM") + 100;
  expect_refusal("cut short");
  game_continues();
}
