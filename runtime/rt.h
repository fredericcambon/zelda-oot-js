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
#define JPEG_TASK_CYCLES 200000u
#define JPEG_UCODE 0x800e4b10u   // the JPEG decode microcode (runtime/jpeg.c)
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
// Timed events are named by kind, not by function, so that a queued event can be written to a saved state. The numbers
// are part of the state: new kinds take new numbers.
enum TimedKind {
  TE_WAKE_SLEEPER = 1, // a: OSThread address
  TE_TIMER = 2,        // a: OSTimer address
  TE_PI_DONE = 3,      // a: OSIoMesg address
  TE_SI_DONE = 4,      // a: queue of the controller call
  TE_VI_RETRACE = 5,
  TE_RSP_EVENT = 6,    // a: interrupt event to send
  TE_AI_FINISHED = 7,
  TE_USER = 255,       // runs the function of rt_set_user_event; for hosts and tests, and not part of a saved state
};
// Schedules the event `kind` with arguments `a` and `b` at an absolute time; used by the devices.
void rt_schedule(uint64_t when, int kind, uint32_t a, uint32_t b);
int rt_cancel(int kind, uint32_t a);
typedef void (*TimedFn)(uint32_t a, uint32_t b);
void rt_set_user_event(TimedFn fn);
// The handlers of the device events, run by the clock.
void te_wake_sleeper(uint32_t thread, uint32_t unused);
void te_timer(uint32_t timer, uint32_t unused);
void te_pi_done(uint32_t mesg, uint32_t unused);
void te_si_done(uint32_t queue, uint32_t unused);
void te_vi_retrace(uint32_t a, uint32_t b);
void te_rsp_event(uint32_t event, uint32_t unused);
void te_ai_finished(uint32_t a, uint32_t b);
// Time at which the next scheduled event is due; returns 0 when there is none.
int rt_next_event(uint64_t *when);

// Anything the runtime cannot continue after (a missing function, a blocking call outside a thread).
typedef void (*FatalHandler)(const char *message);
void rt_set_fatal_handler(FatalHandler fn);
__attribute__((noreturn, format(printf, 1, 2))) void rt_fatal(const char *fmt, ...);

// Coverage builds: a new video frame starts, which resets the loop watchdog; other builds do nothing.
void rt_cov_frame(void);

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
void rt_jpeg_task(const RspTask *task);
uint32_t rt_jpeg_tasks(void);
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

// ---- Call chains and blocking sites ------------------------------------------------------------------------
// A thread that is not running waits in a runtime routine at a blocking site. The ids are part of the portable
// state: new sites take new ids, and the existing ones keep theirs.
enum BlockSite {
  BS_NONE = 0,
  BS_RECV_WAIT = 1,  // osRecvMesg, waiting for a message
  BS_RECV_YIELD = 2, // osRecvMesg, preempted after it received one
  BS_SEND_WAIT = 3,
  BS_SEND_YIELD = 4,
  BS_JAM_WAIT = 5,
  BS_JAM_YIELD = 6,
  BS_YIELD_THREAD = 7,  // osYieldThread
  BS_STOP_SELF = 8,     // osStopThread on the running thread
  BS_START_YIELD = 9,   // osStartThread made a higher priority thread runnable
  BS_PRI_PARK = 10,     // osSetThreadPri to 0: the idle loop
  BS_PRI_YIELD = 11,
  BS_GETCOUNT = 12,     // osGetCount, preempted while it charges time
  BS_GETTIME = 13,
  BS_AIGETLENGTH = 14,
  BS_VIGETFB = 15,      // osViGetCurrentFramebuffer
  BS_CONTINIT_SLEEP = 16,
};

// A runtime routine that calls recompiled code and uses its own locals afterwards keeps them in a frame on the
// shadow stack: the frame id, then its payload words. Frame ids are above every call site key.
#define RT_FRAME_BASE 0xF0000000u
#define RT_FRAME_OVERLAY_LOAD (RT_FRAME_BASE + 1) // payload: the link address and the load address
#define RT_FRAME_CONT_TRANSFER (RT_FRAME_BASE + 2) // osContStartReadData/osContStartQuery waiting on the queue; payload: the queue and 1 for a read
// A frame whose routine waits itself, so that a chain may end in it.
static inline int rt_frame_blocks(uint32_t id) { return id == RT_FRAME_CONT_TRANSFER; }

// True while the call chain of the thread behind `c` is being rebuilt and the thread waited at `site`.
static inline int resuming_at(const Cpu *c, int site) { return c->resume && c->blk_id == (uint32_t)site; }

// The function that a call in resume mode reaches next: the one holding the next call site of the chain, or the
// routine of the blocking site at its end.
GuestFn rt_resume_target(Cpu *c);

// Describes every guest thread so that a fresh instance can rebuild them (see "Portable save states" in
// docs/runtime.md). Call between two oot_frame() calls. Returns the size in bytes; with `buf` NULL nothing is
// written. Returns 0 and sets rt_state_error() when the threads cannot be described.
uint32_t rt_threads_describe(uint8_t *buf, uint32_t cap);
// Replaces the threads with the described ones. The guest memory and the runtime's other state have to be those
// of the description already. Returns 0 and sets rt_state_error() when the description is refused; the threads
// are then untouched.
int rt_threads_rebuild(const uint8_t *buf, uint32_t len);
// Like rt_threads_rebuild, but only checks the description.
int rt_threads_check(const uint8_t *buf, uint32_t len);
const char *rt_state_error(void);

// ---- Portable state ---------------------------------------------------------------------------------
// The state of the game as build-independent data (docs/runtime.md, "Portable save states"). All words are
// little-endian. A Writer with no buffer only counts.
typedef struct Writer {
  uint8_t *buf;
  uint32_t cap, len;
} Writer;
typedef struct Reader {
  const uint8_t *buf;
  uint32_t len, pos;
  int bad;
} Reader;
void put32(Writer *w, uint32_t v);
void put64(Writer *w, uint64_t v);
uint32_t get32(Reader *r);
uint64_t get64(Reader *r);

// Version of the format that rt_state_save writes and rt_state_load reads. It changes when a variable is added to
// or removed from the state.
#define RT_STATE_VERSION 1u
// Writes the state into `buf`; with `buf` NULL it only measures. Call between two frames. Returns the size in bytes, or
// 0 with rt_state_error() set when the game is somewhere a state cannot hold.
uint32_t rt_state_save(uint8_t *buf, uint32_t cap);
// Replaces the state of the game with a saved one. Returns 0 with rt_state_error() set when the state is refused;
// the game is then as it was. The cartridge's save memory is not part of a state and is left alone.
int rt_state_load(const uint8_t *buf, uint32_t len);
// Records why a save or load was refused; returns 0.
int rt_state_refuse(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
void rt_state_clear(void);

// Each part of the state writes its variables with `*_save` and reads them with `*_load`. A load with `apply` clear
// only checks the data, so that a refusal leaves the game untouched; it returns 0 (after rt_state_refuse) when the
// data is not acceptable.
int dispatch_save(Writer *w);
int dispatch_load(Reader *r, int apply);
int overlays_save(Writer *w);
int overlays_load(Reader *r, int apply);
int clock_save(Writer *w);
int clock_load(Reader *r, int apply);
int cont_save(Writer *w);
int cont_load(Reader *r, int apply);
int pi_save(Writer *w);
int pi_load(Reader *r, int apply);
int vi_save(Writer *w);
int vi_load(Reader *r, int apply);
int rsp_save(Writer *w);
int rsp_load(Reader *r, int apply);
int jpeg_save(Writer *w);
int jpeg_load(Reader *r, int apply);

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
// Blocks the calling thread until the given time, at blocking site `site`.
void thread_sleep_until(Cpu *c, uint64_t when, int site);
// Sends the message registered for an event.
void event_send(int event);
// Advances the clock for a poll-style call and lets due events run.
void rt_poll(Cpu *c, int site, uint32_t cycles);
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
