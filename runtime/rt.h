// Runtime services: OS replacements, devices and the host interface of the recompiled game.
#ifndef OOT_RT_H
#define OOT_RT_H

#include <stddef.h>
#include "dispatch.h"

// ---- Guest state -------------------------------------------------------------------------------------
// The OS keeps its bookkeeping in the game's own memory. The replacements use the same locations and
// record layouts, so code that reads a queue's count or a thread's priority directly sees the same values.

#define OS_SENTINEL 0x80006850u   // empty wait list; a node of priority -1 that ends every walk
#define OS_RUNQUEUE 0x80006858u   // head of the runnable threads
#define OS_ALLTHREADS 0x8000685cu // head of the list of all created threads
#define OS_RUNNING 0x80006860u    // the running thread
#define OS_CLOCK_RATE 0x80006870u // 64-bit osClockRate
#define OS_VI_CLOCK 0x80006878u
#define OS_EVENT_TABLE 0x8000a410u // {queue, message} per event

#define OS_TV_TYPE 0x80000300u
#define OS_ROM_BASE 0x80000308u
#define OS_RESET_TYPE 0x8000030cu
#define OS_MEM_SIZE 0x80000318u

// OSThread
#define TH_NEXT 0x00
#define TH_PRI 0x04
#define TH_QUEUE 0x08
#define TH_TLNEXT 0x0c
#define TH_STATE 0x10 // halfword
#define TH_FLAGS 0x12 // halfword
#define TH_ID 0x14
enum { TS_STOPPED = 1, TS_RUNNABLE = 2, TS_RUNNING = 4, TS_WAITING = 8 };

// OSMesgQueue
#define MQ_MT 0x00   // threads waiting to receive
#define MQ_FULL 0x04 // threads waiting to send
#define MQ_VALID 0x08
#define MQ_FIRST 0x0c
#define MQ_COUNT 0x10
#define MQ_MSG 0x14

#define OS_MESG_NOBLOCK 0
#define OS_MESG_BLOCK 1

// Interrupt events of osSetEventMesg. The exception handler (0x800025b0) calls os_internal_exception_send_event
// (0x80002ad4) with the byte offset of the event's entry in the table at 0x8000a410, 8 bytes per entry, so an
// event index is that argument divided by 8:
//   3  COUNTER  Compare acknowledged by mfc0/mtc0 $11, argument 0x18 (0x80002808)
//   4  SP       SP_STATUS written with 0x8008 and signal bits 0x300 set, argument 0x20 (0x800028ac)
//   5  SI       SI_STATUS cleared, argument 0x28 (0x80002938)
//   6  AI       AI_STATUS written, argument 0x30 (0x80002914)
//   7  VI       VI_CURRENT cleared, argument 0x38 (0x800028e8)
//   8  PI       PI_STATUS written with 2, argument 0x40 (0x80002964)
//   9  DP       MI_MODE written with 0x800, argument 0x48 (0x80002990)
// The other arguments are 0, 0x8, 0x10, 0x50, 0x58, 0x60 and 0x70 (0x80002a2c, 0x80002a0c, 0x80002854,
// 0x80002a48, 0x800028c4, 0x80002ac4, 0x800029d8); the table therefore has 15 entries.
// 0x80005f5c and 0x80005f44 register events 3 and 7 with osSetEventMesg.
enum {
  EVENT_COUNTER = 3,
  EVENT_SP = 4,
  EVENT_SI = 5,
  EVENT_AI = 6,
  EVENT_VI = 7,
  EVENT_PI = 8,
  EVENT_DP = 9,
  EVENT_COUNT = 15,
};

// Count ticks per second (osClockRate * 3 / 4, as osInitialize derives it).
#define RT_CPU_COUNTER 46875000ull
#define RT_VI_HZ 50u

// Device timing of the model, in Count ticks. Only the order in which things complete matters to the game; the
// values are those of a plausible machine, not measurements.
#define PI_SETUP_CYCLES 2000u    // fixed cost of a PI transfer
#define PI_CYCLES_PER_BYTE 4u
#define SI_CYCLES 20000u         // one PIF transfer
#define GFX_TASK_CYCLES 300000u  // from submitting a graphics task to the RSP interrupt
#define AUDIO_TASK_CYCLES 100000u
#define HALT_TASK_CYCLES 1000u   // a task whose microcode only halts
#define HALT_UCODE 0x800066C0u   // that microcode: it writes SP_STATUS and breaks (docs/re/boot-flow.md section 7)
#define DP_DELAY_CYCLES 2000u    // RDP completion after the RSP

// ---- Host interface ----------------------------------------------------------------------------------

enum { RT_RUN_TIME = 0, RT_RUN_IDLE = 1 };

// Clears the host side of the runtime (threads, devices, pending events, clock). Guest memory is untouched.
void rt_reset(void);
// Writes the values the IPL leaves in low memory for a PAL cartridge.
void rt_boot_state(void);
// Runs `entry` as the boot context (a function of the dispatch tables) with the given stack pointer. It runs
// until it starts the first thread, which is when the real boot code is abandoned for good.
void rt_start(uint32_t entry, uint32_t sp);
// Runs threads and delivers device events until the virtual clock reaches `until` (RT_RUN_TIME) or nothing
// can ever run again (RT_RUN_IDLE).
int rt_run(uint64_t until);
uint64_t rt_clock(void);
// Schedules `fn(a, b)` at an absolute time; used by the devices.
typedef void (*TimedFn)(uint32_t a, uint32_t b);
void rt_schedule(uint64_t when, TimedFn fn, uint32_t a, uint32_t b);
int rt_cancel(TimedFn fn, uint32_t a);
// Time at which the next scheduled event is due; returns 0 when there is none.
int rt_next_event(uint64_t *when);

// Anything the runtime cannot continue after (a missing function, a blocking call outside a thread).
typedef void (*FatalHandler)(const char *message);
void rt_set_fatal_handler(FatalHandler fn);
__attribute__((noreturn, format(printf, 1, 2))) void rt_fatal(const char *fmt, ...);

// Direct transfers and indirect calls that found no function, one record per address.
uint32_t rt_missing_count(void);
int rt_missing_get(uint32_t index, uint32_t *addr, uint32_t *hits);

// ROM (big-endian image, as read from the cartridge). The runtime keeps the pointer.
void rt_rom_set(const uint8_t *data, size_t size);
// The save memory behind the cartridge's SRAM window, and whether the game wrote it since the last call.
#define RT_SRAM_SIZE 0x20000u
uint8_t *rt_sram(size_t *size);
int rt_sram_take_dirty(void);

// Controllers: buttons as the halfword the game reads, stick positions as signed bytes.
void rt_pad_connect(unsigned mask);
void rt_pad_set(unsigned port, uint16_t buttons, int8_t x, int8_t y);

// Overlays: where each recompiled overlay currently sits in RAM.
int rt_overlay_map(uint32_t link_start, uint32_t load_addr);
void rt_overlay_unmap(uint32_t link_start);

// Graphics and audio tasks submitted to the RSP, and audio buffers queued to the AI.
typedef struct RspTask {
  uint32_t addr;
  uint32_t type, flags;
  uint32_t ucode_boot, ucode_boot_size;
  uint32_t ucode, ucode_size;
  uint32_t ucode_data, ucode_data_size;
  uint32_t dram_stack, dram_stack_size;
  uint32_t output_buff, output_buff_end;
  uint32_t data_ptr, data_size;
  uint32_t yield_data_ptr, yield_data_size;
} RspTask;
// Task types (the word at +0). 2 is the audio task (builder at 0x800bb124); the scheduler that submits tasks
// (0x800a3758-0x800a37b4) separates exactly the types 2 and 1, and 1 is taken to be the graphics task.
// Type 4 is submitted with the microcode at 0x800066c0, whose words are `ori at,zero,0x4000`, `mtc0 at,$4` (the RSP's
// SP_STATUS) and `break` (0x800066c4-0x800066cc): a task that only halts, which the runtime completes at once.
enum { TASK_GFX = 1, TASK_AUDIO = 2, TASK_HALT = 4 };
typedef void (*RspHook)(const RspTask *task);
void rt_set_gfx_hook(RspHook fn);
void rt_set_audio_hook(RspHook fn);
typedef void (*AiHook)(uint32_t addr, uint32_t length);
void rt_set_ai_hook(AiHook fn);
uint32_t rt_ai_rate(void);
void rt_ai_set_rate(uint32_t hz);

// Video state for the renderer.
typedef struct RtVi {
  uint32_t framebuffer; // shown now
  uint32_t mode;        // OSViMode pointer
  int black;
  uint32_t retraces;
} RtVi;
void rt_vi_get(RtVi *out);

// ---- Shared by the runtime files ---------------------------------------------------------------------

#define ARG(n) ((uint32_t)c->r[4 + (n)])
// Fifth and later arguments sit on the caller's stack after the four register slots.
#define STACK_ARG(n) rd32((uint32_t)c->r[29] + 16 + 4 * ((n) - 4))
#define RET(v) (c->r[2] = SX32(v))

void sched_reset(void);
void pi_reset(void);
void vi_reset(void);
void cont_reset(void);
void rsp_reset(void);
void timers_reset(void);

// Sends `msg` to the queue when it has room, waking the first receiver; returns 0 when the queue is full.
int mq_try_send(uint32_t q, uint32_t msg);
void mq_init(uint32_t q, uint32_t buffer, uint32_t count);
// Blocks the calling thread until the given time.
void thread_sleep_until(uint64_t when);
// Sends the message registered for an event.
void event_send(int event);
// Advances the clock for a poll-style call and lets due events run.
void rt_poll(uint32_t cycles);
void clock_set(uint64_t now);
extern uint32_t rt_status;
void events_run_due(void);

// ---- OS replacements ---------------------------------------------------------------------------------------
// Each takes its arguments from the CPU context like the routine it stands for and returns in $v0. The
// generated bindings name the routine rt_<id>, and these definitions take precedence over the recompiled bodies.

void rt_osAiGetLength(Cpu *c);
void rt_osAiSetFrequency(Cpu *c);
void rt_osAiSetNextBuffer(Cpu *c);
void rt_osContGetQuery(Cpu *c);
void rt_osContGetReadData(Cpu *c);
void rt_osContInit(Cpu *c);
void rt_osContStartQuery(Cpu *c);
void rt_osPfsInit(Cpu *c);
void rt_osContStartReadData(Cpu *c);
void rt_osCreateMesgQueue(Cpu *c);
void rt_osCreatePiManager(Cpu *c);
void rt_osCreateThread(Cpu *c);
void rt_osCreateViManager(Cpu *c);
void rt_osDestroyThread(Cpu *c);
void rt_osDpGetStatus(Cpu *c);
void rt_osDpSetStatus(Cpu *c);
void rt_osEPiReadIo(Cpu *c);
void rt_osEPiStartDma(Cpu *c);
void rt_osEPiWriteIo(Cpu *c);
void rt_osGetCount(Cpu *c);
void rt_osGetIntMask(Cpu *c);
void rt_osGetThreadId(Cpu *c);
void rt_osGetTime(Cpu *c);
void rt_osInitialize(Cpu *c);
void rt_osInvalDCache(Cpu *c);
void rt_osInvalICache(Cpu *c);
void rt_osJamMesg(Cpu *c);
void rt_osMapTLBRdb(Cpu *c);
void rt_osPiGetCmdQueue(Cpu *c);
void rt_osRecvMesg(Cpu *c);
void rt_osSendMesg(Cpu *c);
void rt_osSetEventMesg(Cpu *c);
void rt_osSetIntMask(Cpu *c);
void rt_osSetThreadPri(Cpu *c);
void rt_osSetTimer(Cpu *c);
void rt_osSpTaskLoad(Cpu *c);
void rt_osSpTaskStartGo(Cpu *c);
void rt_osSpTaskYield(Cpu *c);
void rt_osSpTaskYielded(Cpu *c);
void rt_osStartThread(Cpu *c);
void rt_osStopThread(Cpu *c);
void rt_osStopTimer(Cpu *c);
void rt_osUnmapTLBAll(Cpu *c);
void rt_osViBlack(Cpu *c);
void rt_osViGetCurrentFramebuffer(Cpu *c);
void rt_osViGetNextFramebuffer(Cpu *c);
void rt_osViSetEvent(Cpu *c);
void rt_osViSetMode(Cpu *c);
void rt_osViSetSpecialFeatures(Cpu *c);
void rt_osViSetXScale(Cpu *c);
void rt_osViSetYScale(Cpu *c);
void rt_osViSwapBuffer(Cpu *c);
void rt_osWritebackDCache(Cpu *c);
void rt_osWritebackDCacheAll(Cpu *c);
void rt_osYieldThread(Cpu *c);
void rt_os_internal_disable_int(Cpu *c);
void rt_os_internal_get_cause(Cpu *c);
void rt_os_internal_get_fpc_csr(Cpu *c);
void rt_os_internal_get_sr(Cpu *c);
void rt_os_internal_probe_tlb(Cpu *c);
void rt_os_internal_reset_global_int_mask(Cpu *c);
void rt_os_internal_restore_int(Cpu *c);
void rt_os_internal_set_compare(Cpu *c);
void rt_os_internal_set_fpc_csr(Cpu *c);
void rt_os_internal_set_global_int_mask(Cpu *c);
void rt_os_internal_set_hw_intr_routine(Cpu *c);
void rt_os_internal_set_sr(Cpu *c);
void rt_os_internal_sp_device_busy(Cpu *c);
void rt_os_internal_sp_get_status(Cpu *c);
void rt_os_internal_sp_raw_start_dma(Cpu *c);
void rt_os_internal_sp_set_pc(Cpu *c);
void rt_os_internal_sp_set_status(Cpu *c);
void rt_overlay_load(Cpu *c);

#endif
