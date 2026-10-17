// Threads, message queues and events.
//
// Each guest thread runs on an Emscripten fiber and keeps its own CPU context. Scheduling is cooperative:
// a thread gives up the processor only inside an OS call that blocks, yields or makes a higher-priority
// thread runnable. The scheduler itself runs on the host's context (rt_run) and resumes whichever thread the
// run queue puts first, with the same ordering rules as the original dispatcher: higher priority first,
// first come first served among equals.
#include <emscripten/fiber.h>
#include <stdio.h>
#include <stdlib.h>
#include "rt.h"

#define MAX_THREADS 32
#define C_STACK_SIZE 0x40000
#define ASYNCIFY_STACK_SIZE 0x40000
// Time charged for each resumption of a thread, so that threads handing control back and forth advance time.
#define SWITCH_CYCLES 500

typedef struct HostThread {
  uint32_t addr; // the OSThread record in guest memory
  int used;
  int started;
  int dead;      // destroyed while running; its stacks are released once the scheduler regains control
  int parked;    // the idle loop: never resumed (see rt_osSetThreadPri)
  uint32_t entry;
  Cpu cpu;
  emscripten_fiber_t fiber;
  uint8_t *c_stack, *asyncify_stack;
} HostThread;

static HostThread threads[MAX_THREADS];
static HostThread boot_ctx;
static int boot_live;
static HostThread *running; // the guest's running thread; NULL while the boot code or nothing runs
static HostThread *current; // the fiber executing now; NULL on the host's context
static emscripten_fiber_t host_fiber;
static uint8_t host_asyncify_stack[ASYNCIFY_STACK_SIZE];

uint32_t rt_status = 0x2000ff01u;
static uint32_t int_mask = 0xff01u;

static HostThread *find_thread(uint32_t addr) {
  for (int k = 0; k < MAX_THREADS; k++) {
    if (threads[k].used && threads[k].addr == addr) return &threads[k];
  }
  return NULL;
}

static void free_thread(HostThread *t) {
  free(t->c_stack);
  free(t->asyncify_stack);
  memset(t, 0, sizeof *t);
}

void sched_reset(void) {
  for (int k = 0; k < MAX_THREADS; k++) free_thread(&threads[k]);
  free_thread(&boot_ctx);
  boot_live = 0;
  running = NULL;
  current = NULL;
  rt_status = 0x2000ff01u;
  int_mask = 0xff01u;
}

// ---- Wait lists ---------------------------------------------------------------------------------------------
// A list is ordered by descending priority; equal priorities keep their arrival order. The head is the
// address of a pointer word, and the first word of a thread is its own link, so a head and a node can both
// be patched through the address of the pointer that leads to the next node.

static void list_enqueue(uint32_t head, uint32_t thread) {
  int32_t pri = (int32_t)rd32(thread + TH_PRI);
  uint32_t link = head, node = rd32(head);
  while ((int32_t)rd32(node + TH_PRI) >= pri) {
    link = node;
    node = rd32(node);
  }
  wr32(thread + TH_NEXT, node);
  wr32(link, thread);
  wr32(thread + TH_QUEUE, head);
}

static void list_dequeue(uint32_t head, uint32_t thread) {
  uint32_t link = head;
  while (rd32(link) != thread) {
    link = rd32(link);
    if (link == OS_SENTINEL || link == 0) return;
  }
  wr32(link, rd32(thread));
}

static uint32_t list_pop(uint32_t head) {
  uint32_t first = rd32(head);
  if (first == OS_SENTINEL) return 0;
  wr32(head, rd32(first));
  return first;
}

// ---- Switching ----------------------------------------------------------------------------------------------

static void swap_to_host(void) {
  HostThread *me = current;
  if (!me) rt_fatal("blocking OS call outside a thread");
  emscripten_fiber_swap(&me->fiber, &host_fiber);
}

// A thread whose call chain is being rebuilt already has its place in the guest's lists: the blocking primitives
// only park its fiber at the site and leave the guest state as it is.
static int rebuilding(void) { return current && current->cpu.blk_id != 0; }

// Gives the processor to the scheduler at blocking site `site`; returns when the thread runs again.
static void park(int site) {
  HostThread *me = current;
  if (!me) rt_fatal("blocking OS call outside a thread");
  me->cpu.blk_id = (uint32_t)site;
  me->cpu.resume = 0;
  emscripten_fiber_swap(&me->fiber, &host_fiber);
  me->cpu.blk_id = 0;
}

static void set_state(uint32_t thread, int state) { wr16(thread + TH_STATE, (uint16_t)state); }

static void make_runnable(uint32_t thread) {
  set_state(thread, TS_RUNNABLE);
  list_enqueue(OS_RUNQUEUE, thread);
}

static void leave_cpu(int site) {
  if (!rebuilding()) {
    running = NULL;
    wr32(OS_RUNNING, 0);
  }
  park(site);
}

// Puts the running thread behind its equals on the run queue and lets the scheduler choose again.
static void requeue_running(int site) {
  if (!rebuilding()) make_runnable(running->addr);
  leave_cpu(site);
}

static void yield_if_preempted(int site) {
  if (rebuilding()) { requeue_running(site); return; }
  if (!running || current != running) return;
  uint32_t head = rd32(OS_RUNQUEUE);
  if (head == OS_SENTINEL) return;
  if ((int32_t)rd32(head + TH_PRI) > (int32_t)rd32(running->addr + TH_PRI)) requeue_running(site);
}

// Blocks the running thread on a wait list, or on nothing when a timed event will wake it.
static void block_on(uint32_t head, int site) {
  if (rebuilding()) { park(site); return; }
  if (!running || current != running) rt_fatal("blocking OS call outside a thread");
  set_state(running->addr, TS_WAITING);
  if (head) list_enqueue(head, running->addr);
  else wr32(running->addr + TH_QUEUE, 0);
  leave_cpu(site);
}

void rt_poll(Cpu *c, int site, uint32_t cycles) {
  if (!resuming_at(c, site)) {
    clock_set(rt_clock() + cycles);
    events_run_due();
  }
  yield_if_preempted(site);
}

void te_wake_sleeper(uint32_t thread, uint32_t unused) {
  (void)unused;
  make_runnable(thread);
}

void thread_sleep_until(Cpu *c, uint64_t when, int site) {
  if (!resuming_at(c, site)) {
    if (rt_clock() >= when) return;
    if (!running) rt_fatal("sleep outside a thread");
    rt_schedule(when, TE_WAKE_SLEEPER, running->addr, 0);
  }
  block_on(0, site);
}

// ---- Fibers --------------------------------------------------------------------------------------------------

__attribute__((noreturn)) static void thread_exit(HostThread *t);

static void thread_main(void *arg) {
  HostThread *t = arg;
  rt_call(&t->cpu, t->entry);
  thread_exit(t);
}

static void boot_main(void *arg) {
  HostThread *t = arg;
  rt_call(&t->cpu, t->entry);
  // The boot code does not return in the original either; nothing is left to resume.
  boot_live = 0;
  swap_to_host();
  rt_fatal("boot context resumed");
}

static void start_fiber(HostThread *t, void (*main_fn)(void *)) {
  t->c_stack = malloc(C_STACK_SIZE);
  t->asyncify_stack = malloc(ASYNCIFY_STACK_SIZE);
  if (!t->c_stack || !t->asyncify_stack) rt_fatal("out of memory for a thread stack");
  emscripten_fiber_init(&t->fiber, main_fn, t, t->c_stack, C_STACK_SIZE, t->asyncify_stack, ASYNCIFY_STACK_SIZE);
  t->started = 1;
}

static void resume(HostThread *t, void (*main_fn)(void *)) {
  if (!t->started) start_fiber(t, main_fn);
  clock_set(rt_clock() + SWITCH_CYCLES);
  current = t;
  emscripten_fiber_swap(&host_fiber, &t->fiber);
  current = NULL;
  if (t->dead) free_thread(t);
}

// Pops the first runnable thread and makes it the running one.
static void dispatch(void) {
  uint32_t head = list_pop(OS_RUNQUEUE);
  if (!head) return;
  HostThread *t = find_thread(head);
  if (!t) rt_fatal("thread 0x%08x is runnable but was never created", head);
  set_state(head, TS_RUNNING);
  wr32(head + TH_QUEUE, 0);
  running = t;
  wr32(OS_RUNNING, head);
}

int rt_run(uint64_t until) {
  emscripten_fiber_init_from_current_context(&host_fiber, host_asyncify_stack, sizeof host_asyncify_stack);
  for (;;) {
    events_run_due();
    if (boot_live) {
      resume(&boot_ctx, boot_main);
      continue;
    }
    if (rt_clock() >= until) return RT_RUN_TIME;
    if (!running) dispatch();
    if (running) {
      resume(running, thread_main);
      continue;
    }
    uint64_t when;
    if (!rt_next_event(&when)) return RT_RUN_IDLE;
    if (when > until) {
      clock_set(until);
      return RT_RUN_TIME;
    }
    clock_set(when);
  }
}

void rt_start(uint32_t entry, uint32_t sp) {
  free_thread(&boot_ctx);
  boot_ctx.used = 1;
  boot_ctx.entry = entry;
  boot_ctx.cpu.r[29] = SX32(sp);
  boot_live = 1;
}

// ---- Threads ---------------------------------------------------------------------------------------------------

// The thread an OS call addresses: the argument, or the running thread when it is 0.
static uint32_t thread_arg(uint32_t t) {
  if (t) return t;
  if (!running) rt_fatal("OS call on the running thread, but no thread is running");
  return running->addr;
}

// osCreateThread(thread, id, entry, arg, stack top (stack), priority (stack)).
// The thread starts with the FR bit of Status clear, as the initial Status 0xff03 the original stores.
void rt_osCreateThread(Cpu *c) {
  uint32_t t = ARG(0);
  HostThread *h = find_thread(t);
  if (h && h == running) rt_fatal("osCreateThread on the running thread");
  if (h) free_thread(h);
  for (int k = 0; !h && k < MAX_THREADS; k++) {
    if (!threads[k].used) h = &threads[k];
  }
  if (!h) rt_fatal("more than %d threads", MAX_THREADS);
  h->used = 1;
  h->addr = t;
  h->entry = ARG(2);
  h->cpu.fcsr = 0x01000800u;
  h->cpu.r[4] = SX32(ARG(3));
  h->cpu.r[29] = SX32(STACK_ARG(4) - 16);
  h->cpu.r[31] = 0x80002e90u; // the original returns into an exit stub; the end of the fiber plays that part

  wr32(t + TH_NEXT, 0);
  wr32(t + TH_PRI, STACK_ARG(5));
  wr32(t + TH_QUEUE, 0);
  wr32(t + TH_ID, ARG(1));
  wr32(t + 0x11c, ARG(2));
  wr32(t + 0x118, 0xff03u);
  set_state(t, TS_STOPPED);
  wr16(t + TH_FLAGS, 0);
  wr32(t + TH_TLNEXT, rd32(OS_ALLTHREADS));
  wr32(OS_ALLTHREADS, t);
}

void rt_osStartThread(Cpu *c) {
  if (resuming_at(c, BS_START_YIELD)) { yield_if_preempted(BS_START_YIELD); return; }
  uint32_t t = ARG(0);
  int state = rd16(t + TH_STATE);
  if (state == TS_STOPPED) {
    make_runnable(t);
  } else if (state == TS_WAITING) {
    uint32_t q = rd32(t + TH_QUEUE);
    if (q) list_dequeue(q, t);
    make_runnable(t);
  }
  if (current == &boot_ctx) {
    // Nothing was running: the original dispatches and never returns to its caller.
    boot_live = 0;
    swap_to_host();
  }
  yield_if_preempted(BS_START_YIELD);
}

void rt_osStopThread(Cpu *c) {
  if (resuming_at(c, BS_STOP_SELF)) { leave_cpu(BS_STOP_SELF); return; }
  uint32_t t = thread_arg(ARG(0));
  int state = rd16(t + TH_STATE);
  if (state == TS_RUNNING) {
    set_state(t, TS_STOPPED);
    leave_cpu(BS_STOP_SELF);
  } else if (state == TS_RUNNABLE || state == TS_WAITING) {
    uint32_t q = rd32(t + TH_QUEUE);
    if (q) list_dequeue(q, t);
    set_state(t, TS_STOPPED);
  }
}

void rt_osDestroyThread(Cpu *c) {
  uint32_t t = thread_arg(ARG(0));
  HostThread *h = find_thread(t);
  int state = rd16(t + TH_STATE);
  if (state != TS_STOPPED && state != TS_RUNNING) {
    uint32_t q = rd32(t + TH_QUEUE);
    if (q) list_dequeue(q, t);
  }
  for (uint32_t link = OS_ALLTHREADS;;) {
    uint32_t node = rd32(link);
    if (node == t) {
      wr32(link, rd32(t + TH_TLNEXT));
      break;
    }
    if (node == OS_SENTINEL || node == 0) break;
    link = node + TH_TLNEXT;
  }
  if (!h) return;
  rt_cancel(TE_WAKE_SLEEPER, t);
  if (h == running) {
    h->dead = 1;
    leave_cpu(BS_NONE);
    rt_fatal("destroyed thread resumed");
  }
  free_thread(h);
}

__attribute__((noreturn)) static void thread_exit(HostThread *t) {
  t->cpu.r[4] = 0;
  rt_osDestroyThread(&t->cpu);
  rt_fatal("thread exit returned");
}

void rt_osYieldThread(Cpu *c) {
  if (resuming_at(c, BS_YIELD_THREAD)) { requeue_running(BS_YIELD_THREAD); return; }
  if (running && current == running) requeue_running(BS_YIELD_THREAD);
}

// A thread that lowers itself to priority 0 is the idle loop: its code spins without calling the OS, so it
// is parked rather than resumed, and time advances while nothing else is runnable.
void rt_osSetThreadPri(Cpu *c) {
  if (resuming_at(c, BS_PRI_PARK)) goto park;
  if (resuming_at(c, BS_PRI_YIELD)) goto yield;
  uint32_t t = thread_arg(ARG(0));
  int32_t pri = (int32_t)ARG(1);
  HostThread *h = find_thread(t);
  int state = rd16(t + TH_STATE);
  wr32(t + TH_PRI, (uint32_t)pri);
  if (h && h->parked && pri > 0) {
    h->parked = 0;
    make_runnable(t);
  } else if (state == TS_RUNNABLE || state == TS_WAITING) {
    uint32_t q = rd32(t + TH_QUEUE);
    if (q) {
      list_dequeue(q, t);
      list_enqueue(q, t);
    }
  }
  if (h && h == running && current == running && pri == 0) {
    h->parked = 1;
    set_state(t, TS_RUNNABLE);
  park:
    leave_cpu(BS_PRI_PARK);
  }
yield:
  yield_if_preempted(BS_PRI_YIELD);
}

void rt_osGetThreadId(Cpu *c) {
  uint32_t t = ARG(0);
  if (!t) {
    if (!running) { RET(0); return; }
    t = running->addr;
  }
  RET(rd32(t + TH_ID));
}

// ---- Message queues -----------------------------------------------------------------------------------------

void mq_init(uint32_t q, uint32_t buffer, uint32_t count) {
  wr32(q + MQ_MT, OS_SENTINEL);
  wr32(q + MQ_FULL, OS_SENTINEL);
  wr32(q + MQ_VALID, 0);
  wr32(q + MQ_FIRST, 0);
  wr32(q + MQ_COUNT, count);
  wr32(q + MQ_MSG, buffer);
}

void rt_osCreateMesgQueue(Cpu *c) { mq_init(ARG(0), ARG(1), ARG(2)); }

static void wake_first(uint32_t head) {
  uint32_t t = list_pop(head);
  if (t) make_runnable(t);
}

// Waits for room in the queue; returns 0 when `block` is clear and the queue is full.
static int wait_for_room(Cpu *c, uint32_t q, uint32_t block, int site) {
  if (resuming_at(c, site)) goto wait;
  while (rd32(q + MQ_VALID) >= rd32(q + MQ_COUNT)) {
    if (!block) return 0;
  wait:
    block_on(q + MQ_FULL, site);
  }
  return 1;
}

static void put(uint32_t q, uint32_t slot, uint32_t msg) {
  wr32(rd32(q + MQ_MSG) + 4 * slot, msg);
  wr32(q + MQ_VALID, rd32(q + MQ_VALID) + 1);
  wake_first(q + MQ_MT);
}

void rt_osSendMesg(Cpu *c) {
  uint32_t q = ARG(0);
  if (resuming_at(c, BS_SEND_YIELD)) goto yield;
  if (!wait_for_room(c, q, ARG(2), BS_SEND_WAIT)) { RET(-1); return; }
  put(q, (rd32(q + MQ_FIRST) + rd32(q + MQ_VALID)) % rd32(q + MQ_COUNT), ARG(1));
  RET(0);
yield:
  yield_if_preempted(BS_SEND_YIELD);
}

void rt_osJamMesg(Cpu *c) {
  uint32_t q = ARG(0);
  if (resuming_at(c, BS_JAM_YIELD)) goto yield;
  if (!wait_for_room(c, q, ARG(2), BS_JAM_WAIT)) { RET(-1); return; }
  uint32_t count = rd32(q + MQ_COUNT);
  uint32_t first = (rd32(q + MQ_FIRST) + count - 1) % count;
  wr32(q + MQ_FIRST, first);
  put(q, first, ARG(1));
  RET(0);
yield:
  yield_if_preempted(BS_JAM_YIELD);
}

void rt_osRecvMesg(Cpu *c) {
  uint32_t q = ARG(0), out = ARG(1);
  if (resuming_at(c, BS_RECV_WAIT)) goto wait;
  if (resuming_at(c, BS_RECV_YIELD)) goto yield;
  while (rd32(q + MQ_VALID) == 0) {
    if (!ARG(2)) { RET(-1); return; }
  wait:
    block_on(q + MQ_MT, BS_RECV_WAIT);
  }
  uint32_t first = rd32(q + MQ_FIRST);
  if (out) wr32(out, rd32(rd32(q + MQ_MSG) + 4 * first));
  wr32(q + MQ_FIRST, (first + 1) % rd32(q + MQ_COUNT));
  wr32(q + MQ_VALID, rd32(q + MQ_VALID) - 1);
  wake_first(q + MQ_FULL);
  RET(0);
yield:
  yield_if_preempted(BS_RECV_YIELD);
}

int mq_try_send(uint32_t q, uint32_t msg) {
  if (!q || rd32(q + MQ_VALID) >= rd32(q + MQ_COUNT)) return 0;
  put(q, (rd32(q + MQ_FIRST) + rd32(q + MQ_VALID)) % rd32(q + MQ_COUNT), msg);
  return 1;
}

// ---- Events --------------------------------------------------------------------------------------------------

void rt_osSetEventMesg(Cpu *c) {
  uint32_t ev = ARG(0);
  if (ev >= EVENT_COUNT) rt_fatal("osSetEventMesg: event %u", ev);
  wr32(OS_EVENT_TABLE + 8 * ev, ARG(1));
  wr32(OS_EVENT_TABLE + 8 * ev + 4, ARG(2));
}

void event_send(int event) {
  uint32_t entry = OS_EVENT_TABLE + 8 * (uint32_t)event;
  mq_try_send(rd32(entry), rd32(entry + 4));
}

void rt_os_internal_set_hw_intr_routine(Cpu *c) { (void)c; }

// ---- Interrupt state -----------------------------------------------------------------------------------------
// Interrupts are only taken where a thread gives up the processor, so masking them has no effect beyond the
// values the game reads back.

void rt_os_internal_disable_int(Cpu *c) {
  RET(rt_status & 1);
  rt_status &= ~1u;
}

void rt_os_internal_restore_int(Cpu *c) { rt_status |= ARG(0); }
void rt_os_internal_set_sr(Cpu *c) { rt_status = ARG(0); }
void rt_os_internal_get_sr(Cpu *c) { RET(rt_status); }
void rt_os_internal_get_cause(Cpu *c) { RET(0); }

void rt_osSetIntMask(Cpu *c) {
  RET(int_mask);
  int_mask = ARG(0);
}

void rt_osGetIntMask(Cpu *c) { RET(int_mask); }
void rt_os_internal_set_global_int_mask(Cpu *c) { (void)c; }
void rt_os_internal_reset_global_int_mask(Cpu *c) { (void)c; }

void rt_os_internal_set_fpc_csr(Cpu *c) {
  uint32_t old = c->fcsr;
  c->fcsr = ARG(0) & FCSR_VALID;
  RET(old);
}

void rt_os_internal_get_fpc_csr(Cpu *c) { RET(c->fcsr); }

// ---- Call chains of the threads ---------------------------------------------------------------------------
// A thread that is not running is parked in a runtime routine, and the generated functions above it hold its
// host frames. The shadow stack of its context names those frames (OOT_PUSH in runtime/cpu.h), so the chain
// can be written down in terms of the ROM's functions and call sites and rebuilt in another instance: the
// outermost function is entered in resume mode, each function jumps to the site on the stack and re-issues the
// call, and the routine at the end parks the fiber at its blocking site.

// The routine a thread waits in at blocking site `id`.
static GuestFn blocking_routine(uint32_t id) {
  switch (id) {
    case BS_RECV_WAIT: case BS_RECV_YIELD: return rt_osRecvMesg;
    case BS_SEND_WAIT: case BS_SEND_YIELD: return rt_osSendMesg;
    case BS_JAM_WAIT: case BS_JAM_YIELD: return rt_osJamMesg;
    case BS_YIELD_THREAD: return rt_osYieldThread;
    case BS_STOP_SELF: return rt_osStopThread;
    case BS_START_YIELD: return rt_osStartThread;
    case BS_PRI_PARK: case BS_PRI_YIELD: return rt_osSetThreadPri;
    case BS_GETCOUNT: return rt_osGetCount;
    case BS_GETTIME: return rt_osGetTime;
    case BS_AIGETLENGTH: return rt_osAiGetLength;
    case BS_VIGETFB: return rt_osViGetCurrentFramebuffer;
    case BS_CONTINIT_SLEEP: return rt_osContInit;
  }
  return NULL;
}

GuestFn rt_resume_target(Cpu *c) {
  if (c->rpos >= c->shn) return blocking_routine(c->blk_id);
  uint32_t key = c->sh[c->rpos];
  if (key == RT_FRAME_OVERLAY_LOAD) return rt_overlay_load;
  if (key == RT_FRAME_CONT_TRANSFER) return c->sh[c->rpos + 2] ? rt_osContStartReadData : rt_osContStartQuery;
  return key < oot_site_count ? oot_sites[key].fn : NULL;
}

// The image whose functions hold the call site `key`.
static uint32_t image_of_site(uint32_t key) {
  for (uint32_t k = 0; k < oot_image_count; k++) {
    if (key >= oot_images[k].first_site && key - oot_images[k].first_site < oot_images[k].site_count) return k;
  }
  return 0;
}

// The frames of a shadow stack: a call site of a generated function, or a runtime routine's frame with its payload.
enum { CHAIN_END = 0, CHAIN_SITE = 1, CHAIN_RUNTIME = 2, CHAIN_BAD = -1 };

static int chain_next(const Cpu *c, uint32_t *pos, uint32_t *a, uint32_t *b, uint32_t *d) {
  if (*pos >= c->shn) return CHAIN_END;
  uint32_t key = c->sh[*pos];
  if (key < oot_site_count) {
    *a = key;
    (*pos)++;
    return CHAIN_SITE;
  }
  if ((key == RT_FRAME_OVERLAY_LOAD || key == RT_FRAME_CONT_TRANSFER) && *pos + 3 <= c->shn) {
    *a = key;
    *b = c->sh[*pos + 1];
    *d = c->sh[*pos + 2];
    *pos += 3;
    return CHAIN_RUNTIME;
  }
  return CHAIN_BAD;
}

// The registers a guest program can see; the rest of the context belongs to the host.
static void put_cpu(Writer *w, const Cpu *c) {
  for (int k = 0; k < 32; k++) put64(w, c->r[k]);
  put64(w, c->hi);
  put64(w, c->lo);
  put32(w, c->llbit);
  for (int k = 0; k < 32; k++) put64(w, c->f[k]);
  put32(w, c->fcsr);
  put32(w, c->fir);
  put32(w, c->fr);
}

static void get_cpu(Reader *r, Cpu *c) {
  for (int k = 0; k < 32; k++) c->r[k] = get64(r);
  c->hi = get64(r);
  c->lo = get64(r);
  c->llbit = get32(r);
  for (int k = 0; k < 32; k++) c->f[k] = get64(r);
  c->fcsr = get32(r);
  c->fir = get32(r);
  c->fr = get32(r);
}

#define THREADS_MAGIC 0x44524854u // "THRD"
#define FLAG_STARTED 1u
#define FLAG_PARKED 2u
// A frame as written: its kind, then three words. A call site (kind 0) is the image, the entry address of the
// function and the address of the call; a runtime frame (kind 1) is the frame id and its two payload words.
#define FRAME_SITE 0u
#define FRAME_RUNTIME 1u

uint32_t rt_threads_describe(uint8_t *buf, uint32_t cap) {
  rt_state_clear();
  if (boot_live) return (uint32_t)rt_state_refuse("the game is still booting");
  if (current) return (uint32_t)rt_state_refuse("the threads are described from the host's context only");
  if (running) return (uint32_t)rt_state_refuse("thread 0x%08x is running", running->addr);
  uint32_t count = 0;
  for (int k = 0; k < MAX_THREADS; k++) {
    const HostThread *t = &threads[k];
    if (!t->used) continue;
    count++;
    if (t->dead) return (uint32_t)rt_state_refuse("thread 0x%08x is being destroyed", t->addr);
    if (!t->started) continue;
    if (!blocking_routine(t->cpu.blk_id)) {
      return (uint32_t)rt_state_refuse("thread 0x%08x waits at a place the state cannot hold (site %u)", t->addr, t->cpu.blk_id);
    }
    uint32_t pos = 0, a, b, d;
    int frames = 0, kind, ends_waiting = 0;
    while ((kind = chain_next(&t->cpu, &pos, &a, &b, &d)) > 0) {
      frames++;
      ends_waiting = kind == CHAIN_SITE || rt_frame_blocks(a);
    }
    if (kind == CHAIN_BAD || frames == 0 || !ends_waiting) {
      return (uint32_t)rt_state_refuse("the call chain of thread 0x%08x is not one the state can hold", t->addr);
    }
  }

  Writer w = { buf, cap, 0 };
  put32(&w, THREADS_MAGIC);
  put32(&w, count);
  put32(&w, 0); // the running thread: none between two frames
  put32(&w, rt_status);
  put32(&w, int_mask);
  for (int k = 0; k < MAX_THREADS; k++) {
    const HostThread *t = &threads[k];
    if (!t->used) continue;
    put32(&w, (uint32_t)k);
    put32(&w, t->addr);
    put32(&w, t->entry);
    put32(&w, (t->started ? FLAG_STARTED : 0) | (t->parked ? FLAG_PARKED : 0));
    put_cpu(&w, &t->cpu);
    put32(&w, t->cpu.blk_id);
    uint32_t frames = 0, pos = 0, a, b, d;
    while (chain_next(&t->cpu, &pos, &a, &b, &d) > 0) frames++;
    put32(&w, frames);
    pos = 0;
    int kind;
    while ((kind = chain_next(&t->cpu, &pos, &a, &b, &d)) > 0) {
      if (kind == CHAIN_SITE) {
        put32(&w, FRAME_SITE);
        put32(&w, image_of_site(a));
        put32(&w, oot_sites[a].entry);
        put32(&w, oot_sites[a].site);
      } else {
        put32(&w, FRAME_RUNTIME);
        put32(&w, a);
        put32(&w, b);
        put32(&w, d);
      }
    }
  }
  if (buf && w.len > cap) return (uint32_t)rt_state_refuse("the buffer holds %u bytes and the threads need %u", cap, w.len);
  return w.len;
}

typedef struct Plan {
  uint32_t slot, addr, entry, flags, blk;
  Cpu cpu;
} Plan;

// The key of the call site at `site` of the function entered at `entry` in `image`, or -1.
static int64_t find_site(uint32_t image, uint32_t entry, uint32_t site) {
  for (uint32_t k = 0; k < oot_site_count; k++) {
    if (oot_sites[k].entry == entry && oot_sites[k].site == site && image_of_site(k) == image) return k;
  }
  return -1;
}

static void run_rebuild(HostThread *t) {
  emscripten_fiber_init_from_current_context(&host_fiber, host_asyncify_stack, sizeof host_asyncify_stack);
  current = t;
  emscripten_fiber_swap(&host_fiber, &t->fiber);
  current = NULL;
}

static int rebuild(const uint8_t *buf, uint32_t len, int apply) {
  rt_state_clear();
  Reader r = { buf, len, 0, 0 };
  if (get32(&r) != THREADS_MAGIC) return rt_state_refuse("the thread description is not one this build reads");
  uint32_t count = get32(&r);
  uint32_t running_addr = get32(&r);
  uint32_t status = get32(&r);
  uint32_t mask = get32(&r);
  if (r.bad || count > MAX_THREADS) return rt_state_refuse("the thread description is damaged");
  if (running_addr != 0) return rt_state_refuse("a state with a running thread cannot be loaded");
  Plan *plans = calloc(count ? count : 1, sizeof *plans);
  if (!plans) return rt_state_refuse("out of memory");
  int ok = 0;
  uint32_t used = 0;
  for (uint32_t k = 0; k < count; k++) {
    Plan *p = &plans[k];
    p->slot = get32(&r);
    p->addr = get32(&r);
    p->entry = get32(&r);
    p->flags = get32(&r);
    get_cpu(&r, &p->cpu);
    p->blk = get32(&r);
    uint32_t frames = get32(&r);
    if (r.bad || p->slot >= MAX_THREADS || (used & (1u << p->slot))) { rt_state_refuse("the thread description is damaged"); goto done; }
    used |= 1u << p->slot;
    for (uint32_t j = 0; j < k; j++) {
      if (plans[j].addr == p->addr) { rt_state_refuse("thread 0x%08x is described twice", p->addr); goto done; }
    }
    int ends_waiting = 0;
    for (uint32_t j = 0; j < frames; j++) {
      uint32_t kind = get32(&r), a = get32(&r), b = get32(&r), d = get32(&r);
      if (r.bad) { rt_state_refuse("the thread description is damaged"); goto done; }
      if (p->cpu.shn + 3 > OOT_SH_MAX) { rt_state_refuse("the call chain of thread 0x%08x is too deep", p->addr); goto done; }
      if (kind == FRAME_SITE) {
        int64_t key = find_site(a, b, d);
        if (key < 0) { rt_state_refuse("this build has no call site 0x%08x in the function at 0x%08x (image %u)", d, b, a); goto done; }
        p->cpu.sh[p->cpu.shn++] = (uint32_t)key;
        ends_waiting = 1;
      } else if (kind == FRAME_RUNTIME && (a == RT_FRAME_OVERLAY_LOAD || a == RT_FRAME_CONT_TRANSFER)) {
        ends_waiting = rt_frame_blocks(a);
        p->cpu.sh[p->cpu.shn++] = a;
        p->cpu.sh[p->cpu.shn++] = b;
        p->cpu.sh[p->cpu.shn++] = d;
      } else {
        rt_state_refuse("this build has no runtime frame %u", a);
        goto done;
      }
    }
    if (p->flags & FLAG_STARTED) {
      if (!blocking_routine(p->blk)) { rt_state_refuse("this build has no blocking site %u", p->blk); goto done; }
      if (frames == 0 || !ends_waiting) { rt_state_refuse("the call chain of thread 0x%08x is not one this build reads", p->addr); goto done; }
    } else if (p->blk != 0 || frames != 0) {
      rt_state_refuse("the thread description is damaged");
      goto done;
    }
  }
  if (r.bad) { rt_state_refuse("the thread description is damaged"); goto done; }

  if (!apply) {
    ok = 1;
    goto done;
  }

  // Everything checked out: from here on the threads are replaced.
  for (int k = 0; k < MAX_THREADS; k++) free_thread(&threads[k]);
  free_thread(&boot_ctx);
  boot_live = 0;
  running = NULL;
  current = NULL;
  rt_status = status;
  int_mask = mask;
  ok = 1;
  for (uint32_t k = 0; k < count; k++) {
    Plan *p = &plans[k];
    HostThread *t = &threads[p->slot];
    t->used = 1;
    t->addr = p->addr;
    t->entry = p->entry;
    t->parked = (p->flags & FLAG_PARKED) != 0;
    t->cpu = p->cpu;
    if (!(p->flags & FLAG_STARTED)) continue;
    t->cpu.blk_id = p->blk;
    t->cpu.rpos = 0;
    t->cpu.resume = 1;
    start_fiber(t, thread_main);
    run_rebuild(t);
    if (t->cpu.blk_id != p->blk || t->cpu.resume || t->cpu.rpos != t->cpu.shn) {
      ok = rt_state_refuse("the call chain of thread 0x%08x did not rebuild", p->addr);
      break;
    }
  }
done:
  free(plans);
  return ok;
}

int rt_threads_check(const uint8_t *buf, uint32_t len) { return rebuild(buf, len, 0); }
int rt_threads_rebuild(const uint8_t *buf, uint32_t len) { return rebuild(buf, len, 1); }
