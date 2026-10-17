// Guest memory, dispatch, the overlay registry, traps, start-up and the routines that do nothing.
#include "harness.h"

static void fa(Cpu *c) { (void)c; tlog("a"); }
static void fb(Cpu *c) { (void)c; tlog("b"); }
static void fo1(Cpu *c) { (void)c; tlog("o1"); }
static void fo2(Cpu *c) { (void)c; tlog("o2"); }

// The recompiled overlay loader the runtime wraps: it returns the loaded size.
void (*loader_hook)(Cpu *c);
void fn_800cd428(Cpu *c) {
  if (!OOT_RESUMING()) tlog("loader ");
  if (loader_hook) loader_hook(c);
  c->r[2] = 0x4000;
}

// ---- Memory --------------------------------------------------------------------------------------------------------

TEST(guest_memory_is_eight_mebibytes_of_big_endian_words) {
  CHECK_EQ(RDRAM_SIZE, 8u * 1024 * 1024);
  wr32(0x80001000u, 0x11223344u);
  CHECK_EQ(rdram[0x1000], 0x11);
  CHECK_EQ(rdram[0x1003], 0x44);
  CHECK_EQ(rd16(0x80001002u), 0x3344);
  CHECK_EQ(rd8(0x80001001u), 0x22);
  wr64(0x80001008u, 0x0102030405060708ull);
  CHECK_EQ(rdram[0x1008], 1);
  CHECK_EQ(rd32(0x8000100cu), 0x05060708u);
  // KSEG0 and KSEG1 views of an address are the same memory.
  CHECK_EQ(rd32(0xa0001000u), 0x11223344u);
  wr16(0x80001010u, 0xabcd);
  CHECK_EQ(rdram[0x1010], 0xab);
}

// ---- Dispatch ---------------------------------------------------------------------------------------------------------

TEST(lookup_finds_functions_by_their_exact_address) {
  guest(0x80100020u, fb);
  guest(0x80100010u, fa);
  CHECK(oot_lookup(0x80100010u) == fa);
  CHECK(oot_lookup(0x80100020u) == fb);
  CHECK(oot_lookup(0x80100014u) == NULL);
  CHECK(oot_lookup(0x80000000u) == NULL);
  rt_call(&host, 0x80100020u);
  rt_call(&host, 0x80100010u);
  CHECK_STR(tlog_get(), "ba");
}

TEST(calling_an_unknown_address_logs_it_and_stops) {
  guest(0x80100010u, fa);
  EXPECT_FATAL(rt_call(&host, 0x80123456u), "missing function at 0x80123456");
  EXPECT_FATAL(rt_call(&host, 0x80123456u), "missing function");
  EXPECT_FATAL(rt_call(&host, 0x80100014u), "missing function at 0x80100014");
  CHECK_EQ(rt_missing_count(), 2);
  uint32_t addr, hits;
  CHECK(rt_missing_get(0, &addr, &hits));
  CHECK_EQ(addr, 0x80123456u);
  CHECK_EQ(hits, 2);
  CHECK(rt_missing_get(1, &addr, &hits));
  CHECK_EQ(addr, 0x80100014u);
  CHECK_EQ(hits, 1);
  CHECK(!rt_missing_get(2, &addr, &hits));
}

TEST(a_direct_transfer_to_an_unrecompiled_address_is_reported_like_an_indirect_call) {
  EXPECT_FATAL(rt_missing(&host, 0x80ffff00u), "missing function at 0x80ffff00");
}

TEST(an_overlay_is_found_only_while_it_is_loaded_at_its_registered_address) {
  guest_overlay(1, 0x10, fo1);
  CHECK(oot_lookup(0x80900010u) == NULL);
  CHECK_EQ(rt_overlay_map(OVERLAY_LINK(1), 0x80700000u), 1);
  CHECK(oot_lookup(0x80700010u) == fo1);
  CHECK(oot_lookup(0x80900010u) == NULL);
  CHECK_EQ(oot_images[1].delta, 0x80700000u - OVERLAY_LINK(1));
  rt_overlay_unmap(OVERLAY_LINK(1));
  CHECK(oot_lookup(0x80700010u) == NULL);
  CHECK_EQ(rt_overlay_map(0x80123000u, 0x80700000u), 0);
}

TEST(loading_an_overlay_over_another_unloads_the_one_it_replaces) {
  guest_overlay(1, 0x10, fo1);
  guest_overlay(2, 0x10, fo2);
  rt_overlay_map(OVERLAY_LINK(1), 0x80700000u);
  rt_overlay_map(OVERLAY_LINK(2), 0x80710000u);
  CHECK(oot_lookup(0x80700010u) == fo1);
  CHECK(oot_lookup(0x80710010u) == fo2);
  rt_overlay_map(OVERLAY_LINK(2), 0x80704000u);
  CHECK(oot_lookup(0x80700010u) == NULL);
  CHECK(oot_lookup(0x80704010u) == fo2);
  CHECK(oot_lookup(0x80710010u) == NULL);
}

TEST(the_overlay_loader_runs_and_then_the_overlay_is_registered_where_it_was_placed) {
  guest_overlay(1, 0x10, fo1);
  sarg(&host, 4, 0x80700000u);
  CHECK_EQ(os(&host, rt_overlay_load, 0x00a00000u, 0x00a08000u, OVERLAY_LINK(1), OVERLAY_LINK(1) + 0x8000u), 0x4000);
  CHECK_STR(tlog_get(), "loader ");
  CHECK(oot_lookup(0x80700010u) == fo1);
  EXPECT_FATAL(os(&host, rt_overlay_load, 0, 0, 0x80123000u, 0x80124000u), "no recompiled overlay");
}

// ---- Traps and COP0 -----------------------------------------------------------------------------------------------------

TEST(processor_exceptions_stop_the_game) {
  EXPECT_FATAL(rt_trap(&host, TRAP_BREAK, 0x80100000u, 7), "exception 3 at 0x80100000 (code 7)");
  EXPECT_FATAL(rt_unimpl(&host, 0x80100004u, 0x12345678u), "untranslated instruction 0x12345678 at 0x80100004");
  EXPECT_FATAL(rt_eret(&host), "eret");
}

TEST(cop0_reads_the_clock_and_the_status_the_os_routines_share) {
  rt_mtc0(&host, 11, 777);
  CHECK_EQ(rt_mfc0(&host, 11), 777);
  rt_mtc0(&host, 12, 0x2000ff03u);
  CHECK_EQ(rt_status, 0x2000ff03u);
  CHECK_EQ(rt_mfc0(&host, 12), 0x2000ff03u);
  rt_mtc0(&host, 9, 5);
  CHECK_EQ(rt_mfc0(&host, 9), 0);
  rt_tlb(&host, TLB_READ, 0x80100000u);
  rt_cache(&host, 0, 0x80100000u);
}

// ---- Start-up ----------------------------------------------------------------------------------------------------------------

TEST(boot_state_describes_a_pal_cartridge) {
  rt_boot_state();
  CHECK_EQ(rd32(OS_TV_TYPE), 0);
  CHECK_EQ(rd32(OS_ROM_BASE), 0xb0000000u);
  CHECK_EQ(rd32(OS_RESET_TYPE), 0);
  CHECK_EQ(rd32(OS_MEM_SIZE), RDRAM_SIZE);
}

TEST(boot_state_describes_an_ntsc_cartridge_at_60_hz) {
  rt_set_vi_hz(60);
  rt_boot_state();
  CHECK_EQ(rd32(OS_TV_TYPE), 1);
  CHECK_EQ(rd32(OS_ROM_BASE), 0xb0000000u);
  rt_set_vi_hz(50);
  rt_boot_state();
  CHECK_EQ(rd32(OS_TV_TYPE), 0);
  rt_set_vi_hz(75);
  CHECK_EQ(rt_vi_hz(), 50);
}

TEST(initialisation_derives_the_clock_rates_and_enables_the_fpu) {
  wr32(OS_CLOCK_RATE, 0);
  wr32(OS_CLOCK_RATE + 4, 62500000u);
  wr32(OS_TV_TYPE, 0);
  for (uint32_t k = 0; k < 0x40; k += 4) wr32(OS_MEM_SIZE + 4 + k, 0xffffffffu);
  os(&host, rt_osInitialize, 0, 0, 0, 0);
  CHECK_EQ(rd32(OS_CLOCK_RATE + 4), 46875000u);
  CHECK_EQ(rd32(OS_CLOCK_RATE), 0);
  CHECK_EQ(rd32(OS_VI_CLOCK), 0x02f5b2d2u);
  CHECK_EQ(rd32(0x80008f90u), 1);
  CHECK(rt_status & 0x20000000u);
  CHECK_EQ(rd32(OS_MEM_SIZE + 4), 0);
  CHECK_EQ(rd32(OS_MEM_SIZE + 4 + 0x3c), 0);
  wr32(OS_TV_TYPE, 2);
  os(&host, rt_osInitialize, 0, 0, 0, 0);
  CHECK_EQ(rd32(OS_VI_CLOCK), 0x02e6025cu);
  wr32(OS_TV_TYPE, 1);
  os(&host, rt_osInitialize, 0, 0, 0, 0);
  CHECK_EQ(rd32(OS_VI_CLOCK), 0x02e6d354u);
}

TEST(initialisation_keeps_the_memory_info_after_a_warm_reset) {
  wr32(OS_RESET_TYPE, 1);
  wr32(OS_MEM_SIZE + 4, 0x1234);
  os(&host, rt_osInitialize, 0, 0, 0, 0);
  CHECK_EQ(rd32(OS_MEM_SIZE + 4), 0x1234);
}

TEST(cache_and_tlb_routines_have_no_effect_on_flat_memory) {
  wr32(0x80001000u, 0x55);
  host.r[2] = 0x77;
  os(&host, rt_osWritebackDCache, 0x80001000u, 16, 0, 0);
  os(&host, rt_osWritebackDCacheAll, 0, 0, 0, 0);
  os(&host, rt_osInvalDCache, 0x80001000u, 16, 0, 0);
  os(&host, rt_osInvalICache, 0x80001000u, 16, 0, 0);
  os(&host, rt_osUnmapTLBAll, 0, 0, 0, 0);
  os(&host, rt_osMapTLBRdb, 0, 0, 0, 0);
  CHECK_EQ(rd32(0x80001000u), 0x55);
  CHECK_EQ(host.r[2], 0x77);
  CHECK_EQ((int32_t)os(&host, rt_os_internal_probe_tlb, 0xc0000000u, 0, 0, 0), -1);
}
