// The RSP, RDP and audio interface. Tasks are not executed: a graphics task goes to the renderer's hook and an
// audio task to the mixer's, and their completion is reported through the same events the interrupts would raise.
#include <stdio.h>
#include <emscripten.h>
#include "rt.h"

// The task record, from osSpTaskLoad (0x800d002c) and its helper 0x800cff10:
// - the helper copies 64 bytes (0x800cff2c-0x800cff34) and converts to physical addresses the pointers at +0x10,
//   +0x18, +0x20, +0x28, +0x2c, +0x30 and +0x38 (0x800cff3c-0x800d0014); it leaves +0x24, +0x34 and +0x3c alone;
// - +4 holds flags: bit 0 makes osSpTaskLoad move the yield data pointer and size (+0x38, +0x3c) into the
//   data fields +0x18 and +0x1c (0x800d0048-0x800d006c), so +0x18/+0x1c and +0x38/+0x3c are (pointer, size) pairs;
// - +8 and +0xc are the pointer and size of the boot microcode, the DMA to RSP memory 0x04001000 at
//   0x800d015c-0x800d0174; the copy of the record itself goes to 0x04000fc0 (0x800d00f4-0x800d0108);
// - the audio task builder at 0x800bb0ec-0x800bb170, next to the caller of osAiSetNextBuffer (0x800bade4), stores
//   type 2 at +0, zero flags, one pointer at both +8 and +0x10 with one size at both +0xc and +0x14, a pointer at
//   +0x18 with a size at +0x1c, and a pointer at +0x30 with its size (count * 8) at +0x34.
// The names follow that: a (pointer, size) pair, or a pointer pair for the output buffer (+0x28, +0x2c).
#define TASK_TYPE 0x00
#define TASK_FLAGS 0x04
#define TASK_UCODE_BOOT 0x08
#define TASK_UCODE_BOOT_SIZE 0x0c
#define TASK_UCODE 0x10
#define TASK_UCODE_SIZE 0x14
#define TASK_UCODE_DATA 0x18
#define TASK_UCODE_DATA_SIZE 0x1c
#define TASK_DRAM_STACK 0x20
#define TASK_DRAM_STACK_SIZE 0x24
#define TASK_OUTPUT_BUFF 0x28
#define TASK_OUTPUT_BUFF_END 0x2c
#define TASK_DATA_PTR 0x30
#define TASK_DATA_SIZE 0x34
#define TASK_YIELD_DATA_PTR 0x38
#define TASK_YIELD_DATA_SIZE 0x3c

static RspHook gfx_hook, audio_hook;
static AiHook ai_hook;
static uint32_t ai_hz = 32000;
// Buffers the AI holds: the one playing and the one queued behind it. Each ends at a time.
static uint64_t ai_end[2];
static uint32_t ai_len[2];
static int ai_count;

void rt_set_gfx_hook(RspHook fn) { gfx_hook = fn; }
void rt_set_audio_hook(RspHook fn) { audio_hook = fn; }
void rt_set_ai_hook(AiHook fn) { ai_hook = fn; }
void rt_ai_set_rate(uint32_t hz) { ai_hz = hz ? hz : 1; }
uint32_t rt_ai_rate(void) { return ai_hz; }

// The kinds of task the game has submitted so far: type, microcode and how many times.
#define TASK_KINDS 16
static struct { uint32_t type, ucode, count; } task_kinds[TASK_KINDS];
static uint32_t task_kind_n;

static void note_task(const RspTask *t) {
  for (uint32_t k = 0; k < task_kind_n; k++) {
    if (task_kinds[k].type == t->type && task_kinds[k].ucode == t->ucode) { task_kinds[k].count++; return; }
  }
  if (task_kind_n < TASK_KINDS) { task_kinds[task_kind_n].type = t->type; task_kinds[task_kind_n].ucode = t->ucode; task_kinds[task_kind_n].count = 1; task_kind_n++; }
}

EMSCRIPTEN_KEEPALIVE uint32_t oot_rsp_task_kinds(void) { return task_kind_n; }
// Field 0 is the task type, 1 the microcode text address, 2 the number of tasks.
EMSCRIPTEN_KEEPALIVE uint32_t oot_rsp_task_kind(uint32_t i, uint32_t field) {
  return field == 0 ? task_kinds[i].type : field == 1 ? task_kinds[i].ucode : task_kinds[i].count;
}

void rsp_reset(void) { ai_count = 0; task_kind_n = 0; }

static void decode_task(uint32_t t, RspTask *out) {
  *out = (RspTask){
    t, rd32(t + TASK_TYPE), rd32(t + TASK_FLAGS),
    rd32(t + TASK_UCODE_BOOT), rd32(t + TASK_UCODE_BOOT_SIZE),
    rd32(t + TASK_UCODE), rd32(t + TASK_UCODE_SIZE),
    rd32(t + TASK_UCODE_DATA), rd32(t + TASK_UCODE_DATA_SIZE),
    rd32(t + TASK_DRAM_STACK), rd32(t + TASK_DRAM_STACK_SIZE),
    rd32(t + TASK_OUTPUT_BUFF), rd32(t + TASK_OUTPUT_BUFF_END),
    rd32(t + TASK_DATA_PTR), rd32(t + TASK_DATA_SIZE),
    rd32(t + TASK_YIELD_DATA_PTR), rd32(t + TASK_YIELD_DATA_SIZE),
  };
}

void te_rsp_event(uint32_t event, uint32_t unused) {
  (void)unused;
  event_send((int)event);
}

// Nothing is loaded into the RSP: osSpTaskStartGo decodes the task it is given and hands it to the hook.
void rt_osSpTaskLoad(Cpu *c) { (void)c; }

void rt_osSpTaskStartGo(Cpu *c) {
  RspTask task;
  decode_task(ARG(0), &task);
  note_task(&task);
  uint64_t done = rt_clock();
  if (task.type == TASK_GFX) {
    if (gfx_hook) gfx_hook(&task);
    done += GFX_TASK_CYCLES;
    rt_schedule(done, TE_RSP_EVENT, EVENT_SP, 0);
    rt_schedule(done + DP_DELAY_CYCLES, TE_RSP_EVENT, EVENT_DP, 0);
  } else if (task.type == TASK_AUDIO) {
    if (audio_hook) audio_hook(&task);
    done += AUDIO_TASK_CYCLES;
    rt_schedule(done, TE_RSP_EVENT, EVENT_SP, 0);
  } else if (task.type == TASK_HALT && task.ucode == JPEG_UCODE) {
    rt_jpeg_task(&task);
    rt_schedule(done + JPEG_TASK_CYCLES, TE_RSP_EVENT, EVENT_SP, 0);
  } else if (task.type == TASK_HALT && (task.ucode == HALT_UCODE || task.ucode_boot == HALT_UCODE)) {
    rt_schedule(done + HALT_TASK_CYCLES, TE_RSP_EVENT, EVENT_SP, 0);
  } else {
    rt_fatal("RSP task of unknown type %u (flags 0x%x, ucode 0x%08x, data 0x%08x+0x%x, called from 0x%08x)", task.type, task.flags, task.ucode, task.data_ptr, task.data_size, (uint32_t)c->r[31]);
  }
}

// A submitted task always runs to completion, so there is never a yielded task to resume.
void rt_osSpTaskYield(Cpu *c) { (void)c; }
void rt_osSpTaskYielded(Cpu *c) { RET(0); }

void rt_os_internal_sp_get_status(Cpu *c) { RET(0x1); } // halted
void rt_os_internal_sp_set_status(Cpu *c) { (void)c; }
void rt_os_internal_sp_device_busy(Cpu *c) { RET(0); }
void rt_os_internal_sp_set_pc(Cpu *c) { RET(0); }
void rt_os_internal_sp_raw_start_dma(Cpu *c) { RET(0); }

void rt_osDpGetStatus(Cpu *c) { RET(0); }
void rt_osDpSetStatus(Cpu *c) { (void)c; }

// ---- Audio interface ---------------------------------------------------------------------------------------------
// A buffer holds 16-bit stereo frames and plays for length / 4 frames at the current rate.

static uint64_t buffer_cycles(uint32_t length) { return (uint64_t)(length / 4) * RT_CPU_COUNTER / ai_hz; }

void te_ai_finished(uint32_t a, uint32_t b) {
  (void)a; (void)b;
  if (ai_count == 0) return;
  ai_end[0] = ai_end[1];
  ai_len[0] = ai_len[1];
  ai_count--;
  event_send(EVENT_AI);
}

// osAiSetFrequency(hz) (0x800d3120): the divisor is the video clock word at 0x80006878 over the rate, rounded to the
// nearest integer (the float add of 0.5 at 0x800d3154-0x800d316c); below 132 the call fails with -1 (0x800d31ec).
// The rate it returns is the clock over the divisor (0x800d3234).
void rt_osAiSetFrequency(Cpu *c) {
  float clock = (float)rd32(OS_VI_CLOCK);
  float wanted = (float)ARG(0);
  uint32_t divisor = (uint32_t)(clock / wanted + 0.5f);
  if (divisor < 132) { RET(-1); return; }
  ai_hz = rd32(OS_VI_CLOCK) / divisor;
  RET(ai_hz);
}

// osAiSetNextBuffer(address, length): -1 when both buffers are taken.
void rt_osAiSetNextBuffer(Cpu *c) {
  if (ai_count == 2) { RET(-1); return; }
  uint64_t start = ai_count ? ai_end[ai_count - 1] : rt_clock();
  uint32_t length = ARG(1);
  ai_end[ai_count] = start + buffer_cycles(length);
  ai_len[ai_count] = length;
  rt_schedule(ai_end[ai_count], TE_AI_FINISHED, 0, 0);
  ai_count++;
  if (ai_hook) ai_hook(ARG(0), length);
  RET(0);
}

// Bytes of the playing buffer that are left.
void rt_osAiGetLength(Cpu *c) {
  rt_poll(c, BS_AIGETLENGTH, 16);
  if (ai_count == 0) { RET(0); return; }
  uint64_t now = rt_clock();
  if (now >= ai_end[0]) { RET(0); return; }
  RET((uint32_t)((ai_end[0] - now) * ai_hz / RT_CPU_COUNTER * 4));
}

// ---- Saved state -------------------------------------------------------------------------------------------

int rsp_save(Writer *w) {
  put32(w, ai_hz);
  put32(w, (uint32_t)ai_count);
  for (int k = 0; k < 2; k++) {
    put64(w, ai_end[k]);
    put32(w, ai_len[k]);
  }
  return 1;
}

int rsp_load(Reader *r, int apply) {
  uint32_t hz = get32(r), count = get32(r);
  uint64_t end[2];
  uint32_t len[2];
  for (int k = 0; k < 2; k++) {
    end[k] = get64(r);
    len[k] = get32(r);
  }
  if (r->bad || hz == 0 || count > 2) return rt_state_refuse("the audio interface state is damaged");
  if (apply) {
    ai_hz = hz;
    ai_count = (int)count;
    memcpy(ai_end, end, sizeof end);
    memcpy(ai_len, len, sizeof len);
  }
  return 1;
}
