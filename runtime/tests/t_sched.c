// Threads, the scheduler, message queues, events and interrupt state.
#include "harness.h"

#define BOOT 0x80100000u
#define MAIN 0x80100100u
#define ENT_A 0x80100200u
#define ENT_B 0x80100300u
#define ENT_C 0x80100400u
#define QUEUE_A 0x80500000u
#define QUEUE_B 0x80500100u

// Runs the boot code, which starts `main_fn` as a thread of priority 20, until nothing can run any more.
static int run_main(GuestFn main_fn) {
  guest(MAIN, main_fn);
  rt_start(BOOT, 0x80600000u);
  return rt_run(100000000ull);
}

static void boot_starts_main(Cpu *c) {
  mk_thread(c, 0, MAIN, 0, 20);
  os(c, rt_osStartThread, THREAD_ADDR(0), 0, 0, 0);
  tlog("boot-after-start");
}

static void setup_boot(void) { guest(BOOT, boot_starts_main); }

static uint32_t state_of(int i) { return rd16(THREAD_ADDR(i) + TH_STATE); }

// ---- Threads -----------------------------------------------------------------------------------------------------

TEST(create_thread_initialises_the_record) {
  uint32_t a = mk_thread(&host, 1, ENT_A, 0x1234, 7);
  uint32_t b = mk_thread(&host, 2, ENT_B, 0, 9);
  CHECK_EQ(rd32(a + TH_PRI), 7);
  CHECK_EQ(rd32(a + TH_ID), 101);
  CHECK_EQ(rd16(a + TH_STATE), TS_STOPPED);
  CHECK_EQ(rd32(a + TH_QUEUE), 0);
  CHECK_EQ(rd32(a + 0x11c), ENT_A);
  CHECK_EQ(rd32(OS_ALLTHREADS), b);
  CHECK_EQ(rd32(b + TH_TLNEXT), a);
  CHECK_EQ(rd32(a + TH_TLNEXT), OS_SENTINEL);
}

static void log_arg_and_return(Cpu *c) { tlog("%c", (char)ARG(0)); }

static void main_starts_three(Cpu *c) {
  mk_thread(c, 1, ENT_A, 'A', 5);
  mk_thread(c, 2, ENT_B, 'B', 10);
  mk_thread(c, 3, ENT_C, 'C', 5);
  os(c, rt_osStartThread, THREAD_ADDR(1), 0, 0, 0);
  os(c, rt_osStartThread, THREAD_ADDR(2), 0, 0, 0);
  os(c, rt_osStartThread, THREAD_ADDR(3), 0, 0, 0);
  tlog("m");
  os(c, rt_osSetThreadPri, 0, 1, 0, 0);
  tlog("M");
}

TEST(higher_priority_runs_first_equals_in_arrival_order) {
  setup_boot();
  guest(ENT_A, log_arg_and_return);
  guest(ENT_B, log_arg_and_return);
  guest(ENT_C, log_arg_and_return);
  CHECK_EQ(run_main(main_starts_three), RT_RUN_IDLE);
  // The creator keeps running until it lowers itself below the others and runs again after them.
  CHECK_STR(tlog_get(), "mBACM");
  CHECK_EQ(rd32(OS_ALLTHREADS), OS_SENTINEL);
}

static void boot_logs_around_start(Cpu *c) {
  tlog("b1 ");
  mk_thread(c, 0, MAIN, 0, 20);
  os(c, rt_osStartThread, THREAD_ADDR(0), 0, 0, 0);
  tlog("b2");
}

static void main_logs(Cpu *c) {
  (void)c;
  tlog("m");
}

TEST(boot_context_is_abandoned_by_the_first_start) {
  guest(BOOT, boot_logs_around_start);
  guest(MAIN, main_logs);
  rt_start(BOOT, 0x80600000u);
  CHECK_EQ(rt_run(1000000), RT_RUN_IDLE);
  CHECK_STR(tlog_get(), "b1 m");
}

static void yielder(Cpu *c) {
  char name = (char)ARG(0);
  for (int k = 0; k < 3; k++) {
    tlog("%c", name);
    os(c, rt_osYieldThread, 0, 0, 0, 0);
  }
}

static void main_starts_yielders(Cpu *c) {
  mk_thread(c, 1, ENT_A, 'A', 5);
  mk_thread(c, 2, ENT_B, 'B', 5);
  os(c, rt_osStartThread, THREAD_ADDR(1), 0, 0, 0);
  os(c, rt_osStartThread, THREAD_ADDR(2), 0, 0, 0);
  os(c, rt_osSetThreadPri, 0, 1, 0, 0);
}

TEST(yield_alternates_between_equal_priorities) {
  setup_boot();
  guest(ENT_A, yielder);
  guest(ENT_B, yielder);
  run_main(main_starts_yielders);
  CHECK_STR(tlog_get(), "ABABAB");
}

static void main_starts_higher(Cpu *c) {
  mk_thread(c, 1, ENT_A, 'B', 25);
  os(c, rt_osStartThread, THREAD_ADDR(1), 0, 0, 0);
  tlog("m");
}

TEST(starting_a_higher_priority_thread_preempts_the_caller) {
  setup_boot();
  guest(ENT_A, log_arg_and_return);
  run_main(main_starts_higher);
  CHECK_STR(tlog_get(), "Bm");
}

static void main_reprioritises(Cpu *c) {
  mk_thread(c, 1, ENT_A, 'A', 5);
  mk_thread(c, 2, ENT_B, 'B', 6);
  os(c, rt_osStartThread, THREAD_ADDR(1), 0, 0, 0);
  os(c, rt_osStartThread, THREAD_ADDR(2), 0, 0, 0);
  os(c, rt_osSetThreadPri, THREAD_ADDR(1), 7, 0, 0);
  CHECK_EQ(rd32(THREAD_ADDR(1) + TH_PRI), 7);
  os(c, rt_osSetThreadPri, 0, 1, 0, 0);
}

TEST(set_priority_reorders_a_runnable_thread) {
  setup_boot();
  guest(ENT_A, log_arg_and_return);
  guest(ENT_B, log_arg_and_return);
  run_main(main_reprioritises);
  CHECK_STR(tlog_get(), "AB");
}

static void stopper(Cpu *c) {
  tlog("a1 ");
  os(c, rt_osStopThread, 0, 0, 0, 0);
  tlog("a2 ");
}

static void main_stops_and_restarts(Cpu *c) {
  mk_thread(c, 1, ENT_A, 0, 25);
  os(c, rt_osStartThread, THREAD_ADDR(1), 0, 0, 0);
  tlog("m1(state %u) ", state_of(1));
  os(c, rt_osStartThread, THREAD_ADDR(1), 0, 0, 0);
  tlog("m2");
}

TEST(a_thread_can_stop_itself_and_be_started_again) {
  setup_boot();
  guest(ENT_A, stopper);
  run_main(main_stops_and_restarts);
  CHECK_STR(tlog_get(), "a1 m1(state 1) a2 m2");
}

static void main_stops_a_runnable_thread(Cpu *c) {
  mk_thread(c, 1, ENT_A, 'A', 5);
  os(c, rt_osStartThread, THREAD_ADDR(1), 0, 0, 0);
  tlog("runnable:%u ", state_of(1));
  os(c, rt_osStopThread, THREAD_ADDR(1), 0, 0, 0);
  tlog("stopped:%u queue:%x", state_of(1), rd32(OS_RUNQUEUE));
  os(c, rt_osSetThreadPri, 0, 1, 0, 0);
}

TEST(stopping_a_runnable_thread_removes_it_from_the_run_queue) {
  setup_boot();
  guest(ENT_A, log_arg_and_return);
  run_main(main_stops_a_runnable_thread);
  CHECK_STR(tlog_get(), "runnable:2 stopped:1 queue:80006850");
}

static void self_destroyer(Cpu *c) {
  tlog("x");
  os(c, rt_osDestroyThread, 0, 0, 0, 0);
  tlog("never");
}

static void main_destroys(Cpu *c) {
  mk_thread(c, 1, ENT_A, 0, 5);
  mk_thread(c, 2, ENT_B, 0, 5);
  os(c, rt_osStartThread, THREAD_ADDR(1), 0, 0, 0);
  os(c, rt_osStartThread, THREAD_ADDR(2), 0, 0, 0);
  os(c, rt_osDestroyThread, THREAD_ADDR(1), 0, 0, 0);
  tlog("list:%x ", rd32(OS_ALLTHREADS) == THREAD_ADDR(2) ? 1u : 0u);
  os(c, rt_osSetThreadPri, 0, 1, 0, 0);
}

TEST(destroy_removes_a_thread_from_the_queues_and_the_list) {
  setup_boot();
  guest(ENT_A, log_arg_and_return);
  guest(ENT_B, self_destroyer);
  run_main(main_destroys);
  CHECK_STR(tlog_get(), "list:1 x");
  CHECK_EQ(rd32(OS_ALLTHREADS), OS_SENTINEL);
}

static void id_reporter(Cpu *c) {
  uint32_t own = os(c, rt_osGetThreadId, 0, 0, 0, 0);
  uint32_t other = os(c, rt_osGetThreadId, THREAD_ADDR(2), 0, 0, 0);
  tlog("%u,%u", own, other);
}

static void main_reports_ids(Cpu *c) {
  mk_thread(c, 1, ENT_A, 0, 5);
  mk_thread(c, 2, ENT_B, 0, 5);
  os(c, rt_osStartThread, THREAD_ADDR(1), 0, 0, 0);
  os(c, rt_osSetThreadPri, 0, 1, 0, 0);
}

TEST(thread_id_of_the_caller_and_of_another_thread) {
  setup_boot();
  guest(ENT_A, id_reporter);
  run_main(main_reports_ids);
  CHECK_STR(tlog_get(), "101,102");
}

static void idle_loop(Cpu *c) {
  mk_thread(c, 2, ENT_B, 'W', 5);
  os(c, rt_osStartThread, THREAD_ADDR(2), 0, 0, 0);
  os(c, rt_osSetThreadPri, 0, 0, 0, 0);
  // The loop the game runs here never calls the OS; the scheduler must not resume it.
  for (volatile int k = 0; k < 1000; k++) {}
  tlog("idle-resumed");
}

static void main_starts_idle(Cpu *c) {
  mk_thread(c, 1, ENT_A, 0, 10);
  os(c, rt_osStartThread, THREAD_ADDR(1), 0, 0, 0);
}

TEST(a_thread_lowering_itself_to_zero_is_parked) {
  setup_boot();
  guest(ENT_A, idle_loop);
  guest(ENT_B, log_arg_and_return);
  CHECK_EQ(run_main(main_starts_idle), RT_RUN_IDLE);
  CHECK_STR(tlog_get(), "W");
  CHECK_EQ(state_of(1), TS_RUNNABLE);
}

// ---- Message queues -----------------------------------------------------------------------------------------------

TEST(create_queue_initialises_the_record) {
  uint32_t q = mk_queue(&host, QUEUE_A, 4);
  CHECK_EQ(rd32(q + MQ_MT), OS_SENTINEL);
  CHECK_EQ(rd32(q + MQ_FULL), OS_SENTINEL);
  CHECK_EQ(rd32(q + MQ_VALID), 0);
  CHECK_EQ(rd32(q + MQ_FIRST), 0);
  CHECK_EQ(rd32(q + MQ_COUNT), 4);
  CHECK_EQ(rd32(q + MQ_MSG), QUEUE_A + 0x20);
}

TEST(messages_are_received_in_the_order_sent_across_the_wrap) {
  uint32_t q = mk_queue(&host, QUEUE_A, 3);
  for (uint32_t k = 1; k <= 3; k++) CHECK_EQ(os(&host, rt_osSendMesg, q, k, OS_MESG_NOBLOCK, 0), 0);
  CHECK_EQ(rd32(q + MQ_VALID), 3);
  CHECK_EQ((int32_t)os(&host, rt_osSendMesg, q, 4, OS_MESG_NOBLOCK, 0), -1);
  uint32_t out = 0x80500800u;
  CHECK_EQ(os(&host, rt_osRecvMesg, q, out, OS_MESG_NOBLOCK, 0), 0);
  CHECK_EQ(rd32(out), 1);
  CHECK_EQ(os(&host, rt_osSendMesg, q, 5, OS_MESG_NOBLOCK, 0), 0);
  CHECK_EQ(rd32(q + MQ_FIRST), 1);
  for (uint32_t want = 2; want <= 5; want++) {
    if (want == 4) continue;
    CHECK_EQ(os(&host, rt_osRecvMesg, q, out, OS_MESG_NOBLOCK, 0), 0);
    CHECK_EQ(rd32(out), want);
  }
  CHECK_EQ((int32_t)os(&host, rt_osRecvMesg, q, out, OS_MESG_NOBLOCK, 0), -1);
  CHECK_EQ(rd32(q + MQ_VALID), 0);
}

TEST(receive_may_discard_the_message) {
  uint32_t q = mk_queue(&host, QUEUE_A, 2);
  os(&host, rt_osSendMesg, q, 9, OS_MESG_NOBLOCK, 0);
  CHECK_EQ(os(&host, rt_osRecvMesg, q, 0, OS_MESG_NOBLOCK, 0), 0);
  CHECK_EQ(rd32(q + MQ_VALID), 0);
}

TEST(jam_inserts_at_the_front) {
  uint32_t q = mk_queue(&host, QUEUE_A, 4);
  os(&host, rt_osSendMesg, q, 1, OS_MESG_NOBLOCK, 0);
  os(&host, rt_osSendMesg, q, 2, OS_MESG_NOBLOCK, 0);
  CHECK_EQ(os(&host, rt_osJamMesg, q, 9, OS_MESG_NOBLOCK, 0), 0);
  CHECK_EQ(os(&host, rt_osJamMesg, q, 8, OS_MESG_NOBLOCK, 0), 0);
  CHECK_EQ((int32_t)os(&host, rt_osJamMesg, q, 7, OS_MESG_NOBLOCK, 0), -1);
  uint32_t out = 0x80500800u;
  uint32_t want[] = { 8, 9, 1, 2 };
  for (int k = 0; k < 4; k++) {
    os(&host, rt_osRecvMesg, q, out, OS_MESG_NOBLOCK, 0);
    CHECK_EQ(rd32(out), want[k]);
  }
}

static void consumer(Cpu *c) {
  uint32_t out = 0x80500800u;
  for (int k = 0; k < 3; k++) {
    os(c, rt_osRecvMesg, QUEUE_A, out, OS_MESG_BLOCK, 0);
    tlog("r%u ", rd32(out));
  }
}

static void producer(Cpu *c) {
  for (uint32_t k = 1; k <= 3; k++) {
    os(c, rt_osSendMesg, QUEUE_A, k, OS_MESG_BLOCK, 0);
    tlog("s%u ", k);
  }
}

static void main_starts_consumer_and_producer(Cpu *c) {
  mk_queue(c, QUEUE_A, 2);
  mk_thread(c, 1, ENT_A, 0, 10);
  mk_thread(c, 2, ENT_B, 0, 5);
  os(c, rt_osStartThread, THREAD_ADDR(1), 0, 0, 0);
  os(c, rt_osStartThread, THREAD_ADDR(2), 0, 0, 0);
}

TEST(a_send_wakes_a_waiting_receiver_that_outranks_the_sender) {
  setup_boot();
  guest(ENT_A, consumer);
  guest(ENT_B, producer);
  run_main(main_starts_consumer_and_producer);
  // The consumer preempts inside each send, so its log precedes the producer's.
  CHECK_STR(tlog_get(), "r1 s1 r2 s2 r3 s3 ");
}

static void receiver(Cpu *c) {
  uint32_t id = ARG(0), out = 0x80500800u + 4 * id;
  os(c, rt_osRecvMesg, QUEUE_A, out, OS_MESG_BLOCK, 0);
  tlog("T%u:%u ", id, rd32(out));
}

static void main_sends_to_two_receivers(Cpu *c) {
  mk_queue(c, QUEUE_A, 4);
  mk_thread(c, 1, ENT_A, 1, 5);
  mk_thread(c, 2, ENT_A, 2, 8);
  os(c, rt_osStartThread, THREAD_ADDR(1), 0, 0, 0);
  os(c, rt_osStartThread, THREAD_ADDR(2), 0, 0, 0);
  os(c, rt_osSetThreadPri, 0, 1, 0, 0);
  // Both receivers are waiting: the first message goes to the higher priority thread.
  os(c, rt_osSendMesg, QUEUE_A, 100, OS_MESG_NOBLOCK, 0);
  os(c, rt_osSendMesg, QUEUE_A, 200, OS_MESG_NOBLOCK, 0);
}

TEST(the_highest_priority_receiver_gets_the_first_message) {
  setup_boot();
  guest(ENT_A, receiver);
  run_main(main_sends_to_two_receivers);
  CHECK_STR(tlog_get(), "T2:100 T1:200 ");
}

static void late_sender(Cpu *c) {
  os(c, rt_osSendMesg, QUEUE_A, 1, OS_MESG_BLOCK, 0);
  tlog("s1 ");
  os(c, rt_osSendMesg, QUEUE_A, 2, OS_MESG_BLOCK, 0);
  tlog("s2done ");
}

static void main_drains_a_full_queue(Cpu *c) {
  uint32_t out = 0x80500800u;
  mk_queue(c, QUEUE_A, 1);
  mk_thread(c, 1, ENT_A, 0, 25);
  os(c, rt_osStartThread, THREAD_ADDR(1), 0, 0, 0);
  tlog("full:%u ", rd32(QUEUE_A + MQ_VALID));
  os(c, rt_osRecvMesg, QUEUE_A, out, OS_MESG_BLOCK, 0);
  tlog("got%u ", rd32(out));
  os(c, rt_osRecvMesg, QUEUE_A, out, OS_MESG_BLOCK, 0);
  tlog("got%u", rd32(out));
}

TEST(a_sender_blocks_on_a_full_queue_until_a_receive_makes_room) {
  setup_boot();
  guest(ENT_A, late_sender);
  run_main(main_drains_a_full_queue);
  CHECK_STR(tlog_get(), "s1 full:1 s2done got1 got2");
}

TEST(blocking_outside_a_thread_is_fatal) {
  uint32_t q = mk_queue(&host, QUEUE_A, 1);
  EXPECT_FATAL(os(&host, rt_osRecvMesg, q, 0, OS_MESG_BLOCK, 0), "outside a thread");
}

// ---- Events ------------------------------------------------------------------------------------------------------

TEST(event_message_is_sent_when_the_queue_has_room) {
  uint32_t q = mk_queue(&host, QUEUE_A, 1);
  os(&host, rt_osSetEventMesg, EVENT_SP, q, 77, 0);
  CHECK_EQ(rd32(OS_EVENT_TABLE + 8 * EVENT_SP), q);
  CHECK_EQ(rd32(OS_EVENT_TABLE + 8 * EVENT_SP + 4), 77);
  event_send(EVENT_SP);
  CHECK_EQ(rd32(q + MQ_VALID), 1);
  event_send(EVENT_SP);
  CHECK_EQ(rd32(q + MQ_VALID), 1);
  event_send(EVENT_DP);
  CHECK_EQ(rd32(q + MQ_VALID), 1);
}

static void fire_event(uint32_t event, uint32_t unused) {
  (void)unused;
  event_send((int)event);
}

static void event_waiter(Cpu *c) {
  uint32_t out = 0x80500800u;
  os(c, rt_osRecvMesg, QUEUE_A, out, OS_MESG_BLOCK, 0);
  tlog("event %u at >=%u", rd32(out), (unsigned)(rt_clock() >= 5000));
}

static void main_waits_for_event(Cpu *c) {
  mk_queue(c, QUEUE_A, 1);
  os(c, rt_osSetEventMesg, EVENT_VI, QUEUE_A, 55, 0);
  mk_thread(c, 1, ENT_A, 0, 10);
  os(c, rt_osStartThread, THREAD_ADDR(1), 0, 0, 0);
}

TEST(an_event_wakes_the_thread_waiting_on_its_queue) {
  setup_boot();
  guest(ENT_A, event_waiter);
  rt_schedule(5000, fire_event, EVENT_VI, 0);
  run_main(main_waits_for_event);
  CHECK_STR(tlog_get(), "event 55 at >=1");
}

TEST(setting_an_event_beyond_the_table_is_fatal) {
  EXPECT_FATAL(os(&host, rt_osSetEventMesg, EVENT_COUNT, 0, 0, 0), "event");
}

// ---- Interrupt state, Status and FPU control --------------------------------------------------------------------------

TEST(disable_and_restore_report_the_previous_enable_bit) {
  CHECK_EQ(os(&host, rt_os_internal_disable_int, 0, 0, 0, 0), 1);
  CHECK_EQ(rt_status & 1, 0);
  CHECK_EQ(os(&host, rt_os_internal_disable_int, 0, 0, 0, 0), 0);
  os(&host, rt_os_internal_restore_int, 0, 0, 0, 0);
  CHECK_EQ(rt_status & 1, 0);
  os(&host, rt_os_internal_restore_int, 1, 0, 0, 0);
  CHECK_EQ(rt_status & 1, 1);
}

TEST(status_and_mask_registers_read_back) {
  os(&host, rt_os_internal_set_sr, 0x2000ff03u, 0, 0, 0);
  CHECK_EQ(os(&host, rt_os_internal_get_sr, 0, 0, 0, 0), 0x2000ff03u);
  CHECK_EQ(rt_mfc0(&host, 12), 0x2000ff03u);
  CHECK_EQ(os(&host, rt_osSetIntMask, 0x1234, 0, 0, 0), 0xff01u);
  CHECK_EQ(os(&host, rt_osGetIntMask, 0, 0, 0, 0), 0x1234);
  CHECK_EQ(os(&host, rt_os_internal_get_cause, 0, 0, 0, 0), 0);
  os(&host, rt_os_internal_set_global_int_mask, 0x400, 0, 0, 0);
  os(&host, rt_os_internal_reset_global_int_mask, 0x400, 0, 0, 0);
  os(&host, rt_os_internal_set_hw_intr_routine, 1, 2, 3, 0);
}

TEST(fpu_control_register_is_set_and_read) {
  host.fcsr = 0x01000800u;
  CHECK_EQ(os(&host, rt_os_internal_set_fpc_csr, 0x00000f83u, 0, 0, 0), 0x01000800u);
  CHECK_EQ(host.fcsr, 0x00000f83u);
  CHECK_EQ(os(&host, rt_os_internal_get_fpc_csr, 0, 0, 0, 0), 0x00000f83u);
}
