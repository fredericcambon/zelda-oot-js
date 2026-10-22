// Timers, cartridge access and PI DMA, the video interface, controllers, RSP tasks and the audio interface.
#include "harness.h"

#define BOOT 0x80100000u
#define MAIN 0x80100100u
#define ENT_A 0x80100200u
#define QUEUE_A 0x80500000u
#define QUEUE_B 0x80500100u
#define QUEUE_C 0x80500200u
#define OUT 0x80500800u

static void noop(uint32_t a, uint32_t b) { (void)a; (void)b; }

// Starts the boot code, which starts a thread of priority 20 running `fn`, and runs until nothing can run.
static void boot_thread(Cpu *c) {
  mk_thread(c, 0, MAIN, 0, 20);
  os(c, rt_osStartThread, THREAD_ADDR(0), 0, 0, 0);
}

static void run_thread(GuestFn fn) {
  guest(BOOT, boot_thread);
  guest(MAIN, fn);
  rt_start(BOOT, 0x80600000u);
  rt_run(1000000000ull);
}

// ---- Time and timers ----------------------------------------------------------------------------------------------

static void set_timer(uint32_t timer, uint64_t countdown, uint64_t interval, uint32_t q, uint32_t msg) {
  sarg(&host, 4, (uint32_t)(interval >> 32));
  sarg(&host, 5, (uint32_t)interval);
  sarg(&host, 6, q);
  sarg(&host, 7, msg);
  os(&host, rt_osSetTimer, timer, 0, (uint32_t)(countdown >> 32), (uint32_t)countdown);
}

TEST(run_stops_at_the_requested_time_and_reports_idle_when_nothing_is_left) {
  CHECK_EQ(rt_run(100), RT_RUN_IDLE);
  CHECK_EQ(rt_clock(), 0);
  rt_set_user_event(noop);
  rt_schedule(1000, TE_USER, 0, 0);
  CHECK_EQ(rt_run(500), RT_RUN_TIME);
  CHECK_EQ(rt_clock(), 500);
  CHECK_EQ(rt_run(2000), RT_RUN_IDLE);
  CHECK_EQ(rt_clock(), 1000);
}

static void log_event(uint32_t a, uint32_t b) { tlog("%u%u ", a, b); }

TEST(events_run_in_time_order_and_in_scheduling_order_when_simultaneous) {
  rt_set_user_event(log_event);
  rt_schedule(30, TE_USER, 3, 0);
  rt_schedule(10, TE_USER, 1, 0);
  rt_schedule(10, TE_USER, 1, 1);
  rt_schedule(20, TE_USER, 2, 0);
  CHECK_EQ(rt_cancel(TE_USER, 2), 1);
  CHECK_EQ(rt_cancel(TE_USER, 2), 0);
  rt_run(100);
  CHECK_STR(tlog_get(), "10 11 30 ");
}

TEST(count_and_time_follow_the_virtual_clock) {
  rt_set_user_event(noop);
  rt_schedule(0x100000000ull + 5, TE_USER, 0, 0);
  rt_run(0x100000000ull + 5);
  uint32_t count = os(&host, rt_osGetCount, 0, 0, 0, 0);
  CHECK(count >= 5 && count < 100);
  os(&host, rt_osGetTime, 0, 0, 0, 0);
  CHECK_EQ((uint32_t)host.r[2], 1);
  CHECK((uint32_t)host.r[3] >= 5 && (uint32_t)host.r[3] < 100);
  CHECK_EQ(rt_mfc0(&host, 9), (uint32_t)rt_clock());
}

TEST(the_compare_register_is_stored_but_never_interrupts) {
  os(&host, rt_os_internal_set_compare, 1234, 0, 0, 0);
  CHECK_EQ(rt_mfc0(&host, 11), 1234);
  rt_run(100000);
}

TEST(a_timer_sends_its_message_once_at_expiry) {
  uint32_t q = mk_queue(&host, QUEUE_A, 4), t = 0x80510000u;
  set_timer(t, 1000, 0, q, 42);
  CHECK(rd32(t) != 0);
  rt_run(999);
  CHECK_EQ(rd32(q + MQ_VALID), 0);
  rt_run(1000);
  CHECK_EQ(rd32(q + MQ_VALID), 1);
  CHECK_EQ(rd32(rd32(q + MQ_MSG)), 42);
  CHECK_EQ(rd32(t), 0);
  rt_run(5000);
  CHECK_EQ(rd32(q + MQ_VALID), 1);
}

TEST(a_periodic_timer_repeats_from_its_expiry_times) {
  uint32_t q = mk_queue(&host, QUEUE_A, 8), t = 0x80510000u;
  set_timer(t, 100, 50, q, 7);
  rt_run(210);
  CHECK_EQ(rd32(q + MQ_VALID), 3);
  CHECK_EQ(rd64(t + 0x10), 250);
  CHECK(rd32(t) != 0);
}

TEST(a_timer_without_a_countdown_first_waits_one_interval) {
  uint32_t q = mk_queue(&host, QUEUE_A, 4), t = 0x80510000u;
  set_timer(t, 0, 300, q, 1);
  rt_run(299);
  CHECK_EQ(rd32(q + MQ_VALID), 0);
  rt_run(300);
  CHECK_EQ(rd32(q + MQ_VALID), 1);
}

TEST(stopping_a_timer_cancels_it_and_reports_a_timer_that_is_not_queued) {
  uint32_t q = mk_queue(&host, QUEUE_A, 4), t = 0x80510000u;
  CHECK_EQ((int32_t)os(&host, rt_osStopTimer, t, 0, 0, 0), -1);
  set_timer(t, 1000, 0, q, 1);
  CHECK_EQ(os(&host, rt_osStopTimer, t, 0, 0, 0), 0);
  CHECK_EQ(rd32(t), 0);
  rt_run(5000);
  CHECK_EQ(rd32(q + MQ_VALID), 0);
  CHECK_EQ((int32_t)os(&host, rt_osStopTimer, t, 0, 0, 0), -1);
}

TEST(setting_a_queued_timer_again_replaces_it) {
  uint32_t q = mk_queue(&host, QUEUE_A, 4), t = 0x80510000u;
  set_timer(t, 100, 0, q, 1);
  set_timer(t, 400, 0, q, 2);
  rt_run(1000);
  CHECK_EQ(rd32(q + MQ_VALID), 1);
  CHECK_EQ(rd32(rd32(q + MQ_MSG)), 2);
}

// ---- Cartridge ----------------------------------------------------------------------------------------------------

#define ROM_BYTES 0x10000u
#define ROM_HANDLE 0x80520000u
#define SRAM_HANDLE 0x80520100u
#define REQUEST 0x80521000u
#define DMA_DST 0x80580000u
static uint8_t rom_image[ROM_BYTES];

static void init_cartridge(void) {
  for (uint32_t k = 0; k < ROM_BYTES; k++) rom_image[k] = (uint8_t)(k * 7 + 3);
  rt_rom_set(rom_image, ROM_BYTES);
  wr32(ROM_HANDLE + 0xc, 0xb0000000u);
  wr32(SRAM_HANDLE + 0xc, 0xa8000000u);
}

static void start_pi_manager(void) { os(&host, rt_osCreatePiManager, 150, QUEUE_A, 0x80510400u, 8); }

static uint32_t request(uint32_t slot, uint32_t reply, uint32_t ram, uint32_t dev, uint32_t size) {
  uint32_t r = REQUEST + 0x40 * slot;
  wr32(r + 4, reply);
  wr32(r + 8, ram);
  wr32(r + 0xc, dev);
  wr32(r + 0x10, size);
  return r;
}

TEST(dma_is_refused_until_the_pi_manager_exists) {
  init_cartridge();
  CHECK_EQ(os(&host, rt_osPiGetCmdQueue, 0, 0, 0, 0), 0);
  CHECK_EQ((int32_t)os(&host, rt_osEPiStartDma, ROM_HANDLE, request(0, QUEUE_B, DMA_DST, 0, 16), 0, 0), -1);
  start_pi_manager();
  CHECK_EQ(os(&host, rt_osPiGetCmdQueue, 0, 0, 0, 0), QUEUE_A);
  CHECK_EQ(rd32(QUEUE_A + MQ_COUNT), 8);
}

TEST(a_rom_read_completes_later_and_replies_with_the_request) {
  init_cartridge();
  start_pi_manager();
  mk_queue(&host, QUEUE_B, 4);
  uint32_t r = request(0, QUEUE_B, DMA_DST, 0x1000, 0x100);
  CHECK_EQ(os(&host, rt_osEPiStartDma, ROM_HANDLE, r, 0, 0), 0);
  CHECK_EQ(rd16(r), 15);
  CHECK_EQ(rd32(r + 0x14), ROM_HANDLE);
  uint64_t done = PI_SETUP_CYCLES + 0x100ull * PI_CYCLES_PER_BYTE;
  rt_run(done - 1);
  CHECK_EQ(rd32(QUEUE_B + MQ_VALID), 0);
  CHECK_EQ(rd8(DMA_DST), 0);
  rt_run(done);
  CHECK_EQ(rd32(QUEUE_B + MQ_VALID), 1);
  CHECK_EQ(rd32(rd32(QUEUE_B + MQ_MSG)), r);
  CHECK_EQ(rd8(r + 3), 0);
  for (uint32_t k = 0; k < 0x100; k++) {
    if (rd8(DMA_DST + k) != rom_image[0x1000 + k]) { CHECK_EQ(k, 0xffffffffu); break; }
  }
  CHECK_EQ(rd8(DMA_DST + 0x100), 0);
}

TEST(dma_requests_complete_in_the_order_made) {
  init_cartridge();
  start_pi_manager();
  mk_queue(&host, QUEUE_B, 4);
  uint32_t r1 = request(0, QUEUE_B, DMA_DST, 0, 0x100), r2 = request(1, QUEUE_B, DMA_DST + 0x1000, 0x200, 0x80);
  os(&host, rt_osEPiStartDma, ROM_HANDLE, r1, 0, 0);
  os(&host, rt_osEPiStartDma, ROM_HANDLE, r2, 0, 0);
  uint64_t first = PI_SETUP_CYCLES + 0x100ull * PI_CYCLES_PER_BYTE;
  uint64_t second = first + PI_SETUP_CYCLES + 0x80ull * PI_CYCLES_PER_BYTE;
  rt_run(second - 1);
  CHECK_EQ(rd32(QUEUE_B + MQ_VALID), 1);
  rt_run(second);
  CHECK_EQ(rd32(QUEUE_B + MQ_VALID), 2);
  CHECK_EQ(rd32(rd32(QUEUE_B + MQ_MSG)), r1);
  CHECK_EQ(rd32(rd32(QUEUE_B + MQ_MSG) + 4), r2);
  CHECK_EQ(rd8(DMA_DST + 0x1000), rom_image[0x200]);
}

TEST(a_read_past_the_end_of_the_rom_returns_zeroes) {
  init_cartridge();
  start_pi_manager();
  mk_queue(&host, QUEUE_B, 4);
  memset(&rdram[DMA_DST & (RDRAM_SIZE - 1)], 0xaa, 32);
  os(&host, rt_osEPiStartDma, ROM_HANDLE, request(0, QUEUE_B, DMA_DST, ROM_BYTES - 8, 16), 0, 0);
  rt_run(100000);
  CHECK_EQ(rd8(DMA_DST + 7), rom_image[ROM_BYTES - 1]);
  CHECK_EQ(rd8(DMA_DST + 8), 0);
}

TEST(save_memory_is_written_and_read_back_through_dma) {
  init_cartridge();
  start_pi_manager();
  mk_queue(&host, QUEUE_B, 4);
  for (uint32_t k = 0; k < 64; k++) wr8(DMA_DST + k, (uint8_t)(0xc0 + k));
  CHECK_EQ(rt_sram_take_dirty(), 0);
  os(&host, rt_osEPiStartDma, SRAM_HANDLE, request(0, QUEUE_B, DMA_DST, 0x100, 64), 1, 0);
  rt_run(100000);
  CHECK_EQ(rd16(request(0, 0, 0, 0, 0)), 16);
  size_t size = 0;
  uint8_t *sram = rt_sram(&size);
  CHECK_EQ(size, RT_SRAM_SIZE);
  CHECK_EQ(sram[0x100], 0xc0);
  CHECK_EQ(sram[0x13f], 0xc0 + 63);
  CHECK_EQ(rt_sram_take_dirty(), 1);
  CHECK_EQ(rt_sram_take_dirty(), 0);
  for (uint32_t k = 0; k < 64; k++) wr8(DMA_DST + k, 0);
  os(&host, rt_osEPiStartDma, SRAM_HANDLE, request(1, QUEUE_B, DMA_DST, 0x100, 64), 0, 0);
  rt_run(200000);
  CHECK_EQ(rd8(DMA_DST + 5), 0xc5);
  CHECK_EQ(rt_sram_take_dirty(), 0);
}

TEST(the_rom_ignores_writes) {
  init_cartridge();
  start_pi_manager();
  mk_queue(&host, QUEUE_B, 4);
  wr8(DMA_DST, 0x55);
  os(&host, rt_osEPiStartDma, ROM_HANDLE, request(0, QUEUE_B, DMA_DST, 0, 4), 1, 0);
  rt_run(100000);
  CHECK_EQ(rom_image[0], 3);
  CHECK_EQ(rt_sram_take_dirty(), 0);
  CHECK_EQ(rd32(QUEUE_B + MQ_VALID), 1);
}

TEST(word_access_reads_the_rom_and_reads_and_writes_the_save_memory) {
  init_cartridge();
  CHECK_EQ(os(&host, rt_osEPiReadIo, ROM_HANDLE, 0x20, OUT, 0), 0);
  CHECK_EQ(rd32(OUT), ((uint32_t)rom_image[0x20] << 24) | (rom_image[0x21] << 16) | (rom_image[0x22] << 8) | rom_image[0x23]);
  CHECK_EQ(os(&host, rt_osEPiWriteIo, SRAM_HANDLE, 0x40, 0x11223344u, 0), 0);
  CHECK_EQ(rt_sram_take_dirty(), 1);
  os(&host, rt_osEPiReadIo, SRAM_HANDLE, 0x40, OUT, 0);
  CHECK_EQ(rd32(OUT), 0x11223344u);
  CHECK_EQ(rt_sram(NULL)[0x41], 0x22);
}

TEST(an_unmapped_cartridge_address_is_fatal) {
  init_cartridge();
  start_pi_manager();
  mk_queue(&host, QUEUE_B, 4);
  wr32(0x80520200u + 0xc, 0xa0000000u);
  os(&host, rt_osEPiStartDma, 0x80520200u, request(0, QUEUE_B, DMA_DST, 0, 16), 0, 0);
  EXPECT_FATAL(rt_run(100000), "unmapped cartridge address");
}

TEST(save_memory_access_outside_the_store_is_fatal) {
  init_cartridge();
  EXPECT_FATAL(os(&host, rt_osEPiReadIo, SRAM_HANDLE, RT_SRAM_SIZE, OUT, 0), "outside");
}

// ---- Video interface ------------------------------------------------------------------------------------------------

#define VI_MODE 0x80530000u
#define VI_FB 0x80600000u
#define VI_PERIOD (RT_CPU_COUNTER / rt_vi_hz())
#define VI_NEXT_CTX() rd32(0x80006944u)
#define VI_CUR_CTX() rd32(0x80006940u)

static void start_vi(void) {
  wr32(VI_MODE + 4, 0x3300);
  os(&host, rt_osCreateViManager, 150, 0, 0, 0);
}

TEST(the_vi_manager_sets_up_two_contexts) {
  start_vi();
  CHECK_EQ(VI_CUR_CTX(), 0x800068e0u);
  CHECK_EQ(VI_NEXT_CTX(), 0x80006910u);
  CHECK_EQ(rd16(VI_CUR_CTX()), 1);
  wr32(VI_NEXT_CTX() + 4, 0x1234);
  os(&host, rt_osCreateViManager, 150, 0, 0, 0);
  CHECK_EQ(rd32(VI_NEXT_CTX() + 4), 0x1234);
}

TEST(video_edits_take_effect_at_the_next_retrace_every_20_ms) {
  CHECK_EQ(rt_vi_hz(), 50);
  start_vi();
  mk_queue(&host, QUEUE_A, 16);
  os(&host, rt_osViSetEvent, QUEUE_A, 99, 1, 0);
  os(&host, rt_osViSetMode, VI_MODE, 0, 0, 0);
  CHECK_EQ(rd32(VI_NEXT_CTX() + 0xc), 0x3300);
  os(&host, rt_osViSwapBuffer, VI_FB, 0, 0, 0);
  CHECK_EQ(os(&host, rt_osViGetNextFramebuffer, 0, 0, 0, 0), VI_FB);
  CHECK_EQ(os(&host, rt_osViGetCurrentFramebuffer, 0, 0, 0, 0), 0);
  CHECK_EQ(rd16(VI_NEXT_CTX()) & 0x10, 0x10);
  CHECK_EQ(VI_PERIOD, 937500);
  rt_run(VI_PERIOD - 1);
  RtVi vi;
  rt_vi_get(&vi);
  CHECK_EQ(vi.retraces, 0);
  CHECK_EQ(rd32(QUEUE_A + MQ_VALID), 0);
  rt_run(VI_PERIOD);
  rt_vi_get(&vi);
  CHECK_EQ(vi.retraces, 1);
  CHECK_EQ(vi.framebuffer, VI_FB);
  CHECK_EQ(vi.mode, VI_MODE);
  CHECK_EQ(os(&host, rt_osViGetCurrentFramebuffer, 0, 0, 0, 0), VI_FB);
  CHECK_EQ(rd32(rd32(QUEUE_A + MQ_MSG)), 99);
  CHECK_EQ(rd16(VI_NEXT_CTX()) & 0x13, 0);
  rt_run(10 * VI_PERIOD);
  rt_vi_get(&vi);
  CHECK_EQ(vi.retraces, 10);
  CHECK_EQ(rd32(QUEUE_A + MQ_VALID), 10);
}

TEST(at_60_hz_the_retrace_comes_every_16_67_ms) {
  rt_set_vi_hz(60);
  start_vi();
  mk_queue(&host, QUEUE_A, 16);
  os(&host, rt_osViSetEvent, QUEUE_A, 7, 1, 0);
  CHECK_EQ(VI_PERIOD, 781250);
  rt_run(VI_PERIOD - 1);
  CHECK_EQ(rd32(QUEUE_A + MQ_VALID), 0);
  rt_run(60 * VI_PERIOD);
  RtVi vi;
  rt_vi_get(&vi);
  CHECK_EQ(vi.retraces, 60);
  CHECK_EQ(rt_clock(), RT_CPU_COUNTER);
  rt_set_vi_hz(RT_VI_HZ_PAL);
}

TEST(a_retrace_count_of_two_notifies_every_other_retrace) {
  start_vi();
  mk_queue(&host, QUEUE_A, 16);
  os(&host, rt_osViSetEvent, QUEUE_A, 5, 2, 0);
  rt_run(10 * VI_PERIOD);
  CHECK_EQ(rd32(QUEUE_A + MQ_VALID), 5);
}

TEST(the_screen_can_be_blanked) {
  start_vi();
  RtVi vi;
  os(&host, rt_osViBlack, 1, 0, 0, 0);
  rt_vi_get(&vi);
  CHECK_EQ(vi.black, 0);
  rt_run(VI_PERIOD);
  rt_vi_get(&vi);
  CHECK_EQ(vi.black, 1);
  os(&host, rt_osViBlack, 0, 0, 0, 0);
  rt_run(2 * VI_PERIOD);
  rt_vi_get(&vi);
  CHECK_EQ(vi.black, 0);
}

TEST(scales_are_stored_as_float_bits_from_the_float_argument_register) {
  start_vi();
  host.f[12] = 0x3f800000u;
  os(&host, rt_osViSetXScale, 0, 0, 0, 0);
  host.f[12] = 0x40000000u;
  os(&host, rt_osViSetYScale, 0, 0, 0, 0);
  uint32_t n = VI_NEXT_CTX();
  CHECK_EQ(rd32(n + 0x24), 0x3f800000u);
  CHECK_EQ(rd32(n + 0x18), 0x40000000u);
  CHECK_EQ(rd16(n) & 6, 6);
  rt_run(VI_PERIOD);
  CHECK_EQ(rd32(VI_CUR_CTX() + 0x24), 0x3f800000u);
  CHECK_EQ(rd32(VI_CUR_CTX() + 0x18), 0x40000000u);
  CHECK_EQ(rd16(n) & 6, 0);
}

TEST(special_features_edit_the_control_word) {
  start_vi();
  os(&host, rt_osViSetMode, VI_MODE, 0, 0, 0);
  uint32_t ctl = VI_NEXT_CTX() + 0xc;
  os(&host, rt_osViSetSpecialFeatures, 0x01, 0, 0, 0);
  CHECK_EQ(rd32(ctl), 0x3308);
  os(&host, rt_osViSetSpecialFeatures, 0x02, 0, 0, 0);
  CHECK_EQ(rd32(ctl), 0x3300);
  os(&host, rt_osViSetSpecialFeatures, 0x04, 0, 0, 0);
  CHECK_EQ(rd32(ctl), 0x3304);
  os(&host, rt_osViSetSpecialFeatures, 0x08, 0, 0, 0);
  CHECK_EQ(rd32(ctl), 0x3300);
  os(&host, rt_osViSetSpecialFeatures, 0x10, 0, 0, 0);
  CHECK_EQ(rd32(ctl), 0x3310);
  os(&host, rt_osViSetSpecialFeatures, 0x20, 0, 0, 0);
  CHECK_EQ(rd32(ctl), 0x3300);
  os(&host, rt_osViSetSpecialFeatures, 0x40, 0, 0, 0);
  CHECK_EQ(rd32(ctl), 0x13000);
  os(&host, rt_osViSetSpecialFeatures, 0x80, 0, 0, 0);
  CHECK_EQ(rd32(ctl), 0x3300);
  CHECK_EQ(rd16(VI_NEXT_CTX()) & 8, 8);
}

// ---- Controllers ------------------------------------------------------------------------------------------------------

#define PAD_OUT 0x80540100u
#define STATUS_OUT 0x80540010u
#define BITS_OUT 0x80540000u

static void controller_thread(Cpu *c) {
  os(c, rt_osContInit, QUEUE_A, BITS_OUT, STATUS_OUT, 0);
  tlog("init@%u ", (unsigned)(rt_clock() >= RT_CPU_COUNTER / 2));
  os(c, rt_osContStartReadData, QUEUE_A, 0, 0, 0);
  os(c, rt_osRecvMesg, QUEUE_A, 0, OS_MESG_BLOCK, 0);
  os(c, rt_osContGetReadData, PAD_OUT, 0, 0, 0);
  tlog("read ");
}

static void controller_main(Cpu *c) {
  mk_queue(c, QUEUE_A, 4);
  os(c, rt_osSetEventMesg, EVENT_SI, QUEUE_A, 0, 0);
  mk_thread(c, 1, ENT_A, 0, 10);
  os(c, rt_osStartThread, THREAD_ADDR(1), 0, 0, 0);
}

TEST(controllers_are_reported_after_half_a_second_and_read_through_the_si_event) {
  guest(ENT_A, controller_thread);
  rt_pad_connect(5);
  rt_pad_set(0, 0x8000, 10, -20);
  rt_pad_set(2, 0x0001, 127, -128);
  run_thread(controller_main);
  CHECK_STR(tlog_get(), "init@1 read ");
  CHECK_EQ(rd8(BITS_OUT), 5);
  CHECK_EQ(rd16(STATUS_OUT), 5);
  CHECK_EQ(rd8(STATUS_OUT + 3), 0);
  CHECK_EQ(rd8(STATUS_OUT + 4 + 3), 8);
  CHECK_EQ(rd16(STATUS_OUT + 8), 5);
  CHECK_EQ(rd8(STATUS_OUT + 12 + 3), 8);
  CHECK_EQ(rd16(PAD_OUT), 0x8000);
  CHECK_EQ(rd8(PAD_OUT + 2), 10);
  CHECK_EQ(rd8(PAD_OUT + 3), 0xec);
  CHECK_EQ(rd8(PAD_OUT + 4), 0);
  CHECK_EQ(rd8(PAD_OUT + 6 + 4), 8);
  CHECK_EQ(rd16(PAD_OUT + 12), 1);
  CHECK_EQ(rd8(PAD_OUT + 12 + 2), 127);
  CHECK_EQ(rd8(PAD_OUT + 12 + 3), 0x80);
  CHECK_EQ(rd8(PAD_OUT + 18 + 4), 8);
}

static void repeat_init_thread(Cpu *c) {
  os(c, rt_osContInit, QUEUE_A, BITS_OUT, STATUS_OUT, 0);
  uint64_t before = rt_clock();
  uint32_t again = os(c, rt_osContInit, QUEUE_A, BITS_OUT, STATUS_OUT, 0);
  tlog("%u %u", again, (unsigned)(rt_clock() - before));
}

TEST(a_second_controller_init_returns_at_once) {
  guest(ENT_A, repeat_init_thread);
  run_thread(controller_main);
  CHECK_STR(tlog_get(), "0 0");
}

static void query_thread(Cpu *c) {
  os(c, rt_osContStartQuery, QUEUE_A, 0, 0, 0);
  os(c, rt_osRecvMesg, QUEUE_A, 0, OS_MESG_BLOCK, 0);
  os(c, rt_osContGetQuery, STATUS_OUT, 0, 0, 0);
  tlog("queried");
}

static void query_main(Cpu *c) {
  mk_queue(c, QUEUE_A, 4);
  mk_thread(c, 1, ENT_A, 0, 10);
  os(c, rt_osStartThread, THREAD_ADDR(1), 0, 0, 0);
}

TEST(a_query_completes_on_the_given_queue_when_no_si_event_is_registered) {
  guest(ENT_A, query_thread);
  rt_pad_connect(2);
  run_thread(query_main);
  CHECK_STR(tlog_get(), "queried");
  CHECK_EQ(rd16(STATUS_OUT + 4), 5);
  CHECK_EQ(rd8(STATUS_OUT + 3), 8);
}

static void pfs_thread(Cpu *c) { tlog("pfs %u", os(c, rt_osPfsInit, QUEUE_A, 0x80551000u, 0, 0)); }

TEST(a_controller_pak_is_never_found) {
  guest(ENT_A, pfs_thread);
  run_thread(query_main);
  CHECK_STR(tlog_get(), "pfs 1");
}

// ---- RSP and RDP --------------------------------------------------------------------------------------------------------

#define TASK 0x80550000u
static RspTask seen[4];
static int seen_n;

static void record_gfx(const RspTask *t) { seen[seen_n++] = *t; }
static void record_audio(const RspTask *t) { seen[seen_n++] = *t; }

static void build_task(uint32_t type) {
  wr32(TASK, type);
  wr32(TASK + 0x04, 2);
  wr32(TASK + 0x08, 0x11);
  wr32(TASK + 0x10, 0x12);
  wr32(TASK + 0x18, 0x13);
  wr32(TASK + 0x30, 0x80560000u);
  wr32(TASK + 0x34, 0x400);
  wr32(TASK + 0x38, 0x80570000u);
}

static void watch_rsp_events(void) {
  mk_queue(&host, QUEUE_A, 4);
  mk_queue(&host, QUEUE_B, 4);
  os(&host, rt_osSetEventMesg, EVENT_SP, QUEUE_A, 1, 0);
  os(&host, rt_osSetEventMesg, EVENT_DP, QUEUE_B, 2, 0);
}

TEST(a_graphics_task_reaches_the_renderer_and_completes_on_the_sp_and_dp_events) {
  seen_n = 0;
  rt_set_gfx_hook(record_gfx);
  watch_rsp_events();
  build_task(TASK_GFX);
  os(&host, rt_osSpTaskLoad, TASK, 0, 0, 0);
  CHECK_EQ(seen_n, 0);
  os(&host, rt_osSpTaskStartGo, TASK, 0, 0, 0);
  CHECK_EQ(seen_n, 1);
  CHECK_EQ(seen[0].addr, TASK);
  CHECK_EQ(seen[0].type, TASK_GFX);
  CHECK_EQ(seen[0].flags, 2);
  CHECK_EQ(seen[0].ucode_boot, 0x11);
  CHECK_EQ(seen[0].ucode, 0x12);
  CHECK_EQ(seen[0].ucode_data, 0x13);
  CHECK_EQ(seen[0].data_ptr, 0x80560000u);
  CHECK_EQ(seen[0].data_size, 0x400);
  CHECK_EQ(seen[0].yield_data_ptr, 0x80570000u);
  rt_run(GFX_TASK_CYCLES - 1);
  CHECK_EQ(rd32(QUEUE_A + MQ_VALID), 0);
  rt_run(GFX_TASK_CYCLES);
  CHECK_EQ(rd32(QUEUE_A + MQ_VALID), 1);
  CHECK_EQ(rd32(QUEUE_B + MQ_VALID), 0);
  rt_run(GFX_TASK_CYCLES + DP_DELAY_CYCLES);
  CHECK_EQ(rd32(QUEUE_B + MQ_VALID), 1);
}

TEST(an_audio_task_reaches_the_mixer_and_completes_on_the_sp_event_only) {
  seen_n = 0;
  rt_set_audio_hook(record_audio);
  watch_rsp_events();
  build_task(TASK_AUDIO);
  os(&host, rt_osSpTaskStartGo, TASK, 0, 0, 0);
  CHECK_EQ(seen_n, 1);
  CHECK_EQ(seen[0].type, TASK_AUDIO);
  rt_run(10 * AUDIO_TASK_CYCLES);
  CHECK_EQ(rd32(QUEUE_A + MQ_VALID), 1);
  CHECK_EQ(rd32(QUEUE_B + MQ_VALID), 0);
}

TEST(a_task_completes_without_a_hook) {
  watch_rsp_events();
  build_task(TASK_GFX);
  os(&host, rt_osSpTaskStartGo, TASK, 0, 0, 0);
  rt_run(GFX_TASK_CYCLES);
  CHECK_EQ(rd32(QUEUE_A + MQ_VALID), 1);
}

TEST(a_halting_task_completes_on_the_sp_event_without_a_hook) {
  seen_n = 0;
  rt_set_gfx_hook(record_gfx);
  rt_set_audio_hook(record_audio);
  watch_rsp_events();
  build_task(TASK_HALT);
  wr32(TASK + 0x10, HALT_UCODE);
  os(&host, rt_osSpTaskStartGo, TASK, 0, 0, 0);
  CHECK_EQ(seen_n, 0);
  rt_run(HALT_TASK_CYCLES);
  CHECK_EQ(rd32(QUEUE_A + MQ_VALID), 1);
  CHECK_EQ(rd32(QUEUE_B + MQ_VALID), 0);
}

TEST(a_halting_task_with_other_microcode_is_fatal) {
  build_task(TASK_HALT);
  EXPECT_FATAL(os(&host, rt_osSpTaskStartGo, TASK, 0, 0, 0), "unknown type 4");
}

TEST(a_task_of_unknown_type_is_fatal) {
  build_task(9);
  EXPECT_FATAL(os(&host, rt_osSpTaskStartGo, TASK, 0, 0, 0), "unknown type 9");
}

TEST(a_submitted_task_never_yields_and_the_rsp_registers_read_idle) {
  os(&host, rt_osSpTaskYield, 0, 0, 0, 0);
  CHECK_EQ(os(&host, rt_osSpTaskYielded, TASK, 0, 0, 0), 0);
  CHECK_EQ(os(&host, rt_os_internal_sp_get_status, 0, 0, 0, 0), 1);
  os(&host, rt_os_internal_sp_set_status, 0x400, 0, 0, 0);
  CHECK_EQ(os(&host, rt_os_internal_sp_device_busy, 0, 0, 0, 0), 0);
  CHECK_EQ(os(&host, rt_os_internal_sp_set_pc, 0, 0, 0, 0), 0);
  CHECK_EQ(os(&host, rt_os_internal_sp_raw_start_dma, 0, 0, 0, 0), 0);
  CHECK_EQ(os(&host, rt_osDpGetStatus, 0, 0, 0, 0), 0);
  os(&host, rt_osDpSetStatus, 1, 0, 0, 0);
}

TEST(a_graphics_task_turns_the_kokiri_tunic_black_and_leaves_the_other_tunics) {
  static const uint8_t table[9] = {0x1e, 0x69, 0x1b, 0x64, 0x14, 0x00, 0x00, 0x3c, 0x64};
  static const uint8_t want[9] = {0x20, 0x20, 0x20, 0x64, 0x14, 0x00, 0x00, 0x3c, 0x64};
  for (int k = 0; k < 9; k++) wr8(0x800f5a38u + k, table[k]);
  rt_set_gfx_hook(record_gfx);
  build_task(TASK_GFX);
  os(&host, rt_osSpTaskStartGo, TASK, 0, 0, 0);
  for (int k = 0; k < 9; k++) CHECK_EQ(rd8(0x800f5a38u + k), want[k]);
}

TEST(a_tunic_table_that_is_not_the_original_green_is_left_alone) {
  wr8(0x800f5a38u, 0x1e);
  wr8(0x800f5a39u, 0x69);
  wr8(0x800f5a3au, 0x1c);
  rt_patch_tunic();
  CHECK_EQ(rd8(0x800f5a38u), 0x1e);
  CHECK_EQ(rd8(0x800f5a3au), 0x1c);
}

// ---- Audio interface ----------------------------------------------------------------------------------------------------

static uint32_t hooked_addr, hooked_len;
static void record_ai(uint32_t addr, uint32_t len) { hooked_addr = addr; hooked_len = len; }

// 3200 frames of four bytes at 32 kHz.
#define AI_BUFFER 12800u
#define AI_BUFFER_CYCLES (3200ull * RT_CPU_COUNTER / 32000)

TEST(the_audio_interface_holds_two_buffers_and_signals_each_end) {
  rt_set_ai_hook(record_ai);
  mk_queue(&host, QUEUE_A, 4);
  os(&host, rt_osSetEventMesg, EVENT_AI, QUEUE_A, 6, 0);
  CHECK_EQ(os(&host, rt_osAiGetLength, 0, 0, 0, 0), 0);
  uint64_t t0 = rt_clock();
  CHECK_EQ(os(&host, rt_osAiSetNextBuffer, 0x80590000u, AI_BUFFER, 0, 0), 0);
  CHECK_EQ(hooked_addr, 0x80590000u);
  CHECK_EQ(hooked_len, AI_BUFFER);
  uint32_t left = os(&host, rt_osAiGetLength, 0, 0, 0, 0);
  CHECK(left > AI_BUFFER - 100 && left <= AI_BUFFER);
  CHECK_EQ(os(&host, rt_osAiSetNextBuffer, 0x80594000u, AI_BUFFER, 0, 0), 0);
  CHECK_EQ((int32_t)os(&host, rt_osAiSetNextBuffer, 0x80598000u, AI_BUFFER, 0, 0), -1);
  rt_run(t0 + AI_BUFFER_CYCLES - 1);
  CHECK_EQ(rd32(QUEUE_A + MQ_VALID), 0);
  rt_run(t0 + AI_BUFFER_CYCLES);
  CHECK_EQ(rd32(QUEUE_A + MQ_VALID), 1);
  CHECK_EQ(os(&host, rt_osAiSetNextBuffer, 0x80598000u, AI_BUFFER, 0, 0), 0);
  rt_run(t0 + 3 * AI_BUFFER_CYCLES);
  CHECK_EQ(rd32(QUEUE_A + MQ_VALID), 3);
  CHECK_EQ(os(&host, rt_osAiGetLength, 0, 0, 0, 0), 0);
}

TEST(a_buffer_queued_after_the_interface_ran_dry_counts_as_a_gap) {
  uint64_t t0 = rt_clock();
  os(&host, rt_osAiSetNextBuffer, 0x80590000u, AI_BUFFER, 0, 0);
  os(&host, rt_osAiSetNextBuffer, 0x80594000u, AI_BUFFER, 0, 0);
  rt_run(t0 + AI_BUFFER_CYCLES);
  os(&host, rt_osAiSetNextBuffer, 0x80598000u, AI_BUFFER, 0, 0);
  CHECK_EQ(rt_ai_gaps(), 0);
  rt_run(t0 + 4 * AI_BUFFER_CYCLES);
  os(&host, rt_osAiSetNextBuffer, 0x80590000u, AI_BUFFER, 0, 0);
  CHECK_EQ(rt_ai_gaps(), 1);
}

TEST(the_audio_rate_sets_how_long_a_buffer_plays) {
  rt_ai_set_rate(16000);
  mk_queue(&host, QUEUE_A, 4);
  os(&host, rt_osSetEventMesg, EVENT_AI, QUEUE_A, 6, 0);
  os(&host, rt_osAiSetNextBuffer, 0x80590000u, AI_BUFFER, 0, 0);
  rt_run(AI_BUFFER_CYCLES);
  CHECK_EQ(rd32(QUEUE_A + MQ_VALID), 0);
  rt_run(2 * AI_BUFFER_CYCLES);
  CHECK_EQ(rd32(QUEUE_A + MQ_VALID), 1);
}

TEST(setting_the_audio_frequency_rounds_the_divisor_and_rejects_rates_that_are_too_fast) {
  wr32(OS_VI_CLOCK, 48681812u);
  CHECK_EQ(os(&host, rt_osAiSetFrequency, 32000, 0, 0, 0), 48681812u / 1521);
  CHECK_EQ(rt_ai_rate(), 48681812u / 1521);
  CHECK_EQ((int32_t)os(&host, rt_osAiSetFrequency, 48681812u / 100, 0, 0, 0), -1);
  CHECK_EQ(rt_ai_rate(), 48681812u / 1521);
}
