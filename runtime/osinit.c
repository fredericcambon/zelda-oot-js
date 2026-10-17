// System start-up, the cache and TLB routines (which have no effect on flat memory), and the reset of the
// whole runtime.
#include "rt.h"

#define OS_INIT_FLAG 0x80008f90u

void rt_reset(void) {
  sched_reset();
  timers_reset();
  pi_reset();
  vi_reset();
  cont_reset();
  rsp_reset();
}

// What the IPL leaves in low memory. 0x80000300 is the TV type: 0 (PAL) is the value for which osInitialize stores
// the clock 0x02f5b2d2 (49.65 MHz, the PAL video clock of n64brew.dev); 0x80000308 is the ROM base that the PI
// DMA code ORs into device addresses (0x80003c48), 0xb0000000 being the cartridge window in KSEG1 (n64brew.dev);
// 0x8000030c = 0 is the cold-reset value osInitialize tests; 0x80000318 receives the RAM size that boot_main
// stores after probing (0x800004e4).
void rt_boot_state(void) {
  wr32(OS_TV_TYPE, rt_vi_hz() == RT_VI_HZ_NTSC ? 1 : 0);
  wr32(OS_ROM_BASE, 0xb0000000u);
  wr32(OS_RESET_TYPE, 0);
  wr32(OS_MEM_SIZE, RDRAM_SIZE);
}

// What osInitialize (0x800031e0-0x80003484) does to state the runtime keeps:
// - 0x800031e8-0x800031fc: stores 1 at 0x80008f90 (lui 0x8001, offset -28784), a flag set before anything else;
// - 0x800031f8-0x80003208: Status |= 0x20000000 (get_sr 0x800035a0, lui 0x2000, set_sr 0x80003590);
// - 0x80003378-0x800033b0: the 64-bit word at 0x80006870 is multiplied by 3 (0x80002448) and divided by 4
//   (0x80002348); its initialised value 62 500 000 (0x03b9aca0) becomes 46 875 000;
// - 0x800033b4-0x800033d4: when the word at 0x8000030c is zero, 0x40 bytes from 0x8000031c are cleared (0x80002ff0);
// - 0x800033d8-0x80003430: the word at 0x80000300 selects what is stored at 0x80006878: 0 gives 0x02f5b2d2, 2 gives
//   0x02e6025c, anything else 0x02e6d354.
void rt_osInitialize(Cpu *c) {
  (void)c;
  wr32(OS_INIT_FLAG, 1);
  rt_status |= 0x20000000u;
  uint64_t rate = ((uint64_t)rd32(OS_CLOCK_RATE) << 32) | rd32(OS_CLOCK_RATE + 4);
  rate = rate * 3 / 4;
  wr32(OS_CLOCK_RATE, (uint32_t)(rate >> 32));
  wr32(OS_CLOCK_RATE + 4, (uint32_t)rate);
  uint32_t tv = rd32(OS_TV_TYPE);
  wr32(OS_VI_CLOCK, tv == 0 ? 0x02f5b2d2u : tv == 2 ? 0x02e6025cu : 0x02e6d354u);
  if (rd32(OS_RESET_TYPE) == 0) {
    for (uint32_t k = 0; k < 0x40; k += 4) wr32(OS_MEM_SIZE + 4 + k, 0);
  }
}

void rt_osWritebackDCache(Cpu *c) { (void)c; }
void rt_osWritebackDCacheAll(Cpu *c) { (void)c; }
void rt_osInvalDCache(Cpu *c) { (void)c; }
void rt_osInvalICache(Cpu *c) { (void)c; }
void rt_osUnmapTLBAll(Cpu *c) { (void)c; }
void rt_osMapTLBRdb(Cpu *c) { (void)c; }
// No page of the game is mapped through the TLB, so a probe never finds one.
void rt_os_internal_probe_tlb(Cpu *c) { RET(-1); }
