// Threads, message queues and events.
//
// Each guest thread runs on an Emscripten fiber and keeps its own CPU context. Scheduling is cooperative:
// a thread gives up the processor only inside an OS call that blocks, yields or makes a higher-priority
// thread runnable. The scheduler itself runs on the host's context (rt_run) and resumes whichever thread the
// run queue puts first, with the same ordering rules as the original dispatcher: higher priority first,
// first come first served among equals.
#include <emscripten/fiber.h>
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

static void set_state(uint32_t thread, int state) { wr16(thread + TH_STATE, (uint16_t)state); }

static void make_runnable(uint32_t thread) {
  set_state(thread, TS_RUNNABLE);
  list_enqueue(OS_RUNQUEUE, thread);
}

static void leave_cpu(void) {
  running = NULL;
  wr32(OS_RUNNING, 0);
  swap_to_host();
}

// Puts the running thread behind its equals on the run queue and lets the scheduler choose again.
static void requeue_running(void) {
  make_runnable(running->addr);
  leave_cpu();
}

static void yield_if_preempted(void) {
  if (!running || current != running) return;
  uint32_t head = rd32(OS_RUNQUEUE);
  if (head == OS_SENTINEL) return;
  if ((int32_t)rd32(head + TH_PRI) > (int32_t)rd32(running->addr + TH_PRI)) requeue_running();
}

// Blocks the running thread on a wait list, or on nothing when a timed event will wake it.
static void block_on(uint32_t head) {
  if (!running || current != running) rt_fatal("blocking OS call outside a thread");
  set_state(running->addr, TS_WAITING);
  if (head) list_enqueue(head, running->addr);
  else wr32(running->addr + TH_QUEUE, 0);
  leave_cpu();
}

void rt_poll(uint32_t cycles) {
  clock_set(rt_clock() + cycles);
  events_run_due();
  yield_if_preempted();
}

static void wake_sleeper(uint32_t thread, uint32_t unused) {
  (void)unused;
  make_runnable(thread);
}

void thread_sleep_until(uint64_t when) {
  if (rt_clock() >= when) return;
  if (!running) rt_fatal("sleep outside a thread");
  rt_schedule(when, wake_sleeper, running->addr, 0);
  block_on(0);
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
  yield_if_preempted();
}

void rt_osStopThread(Cpu *c) {
  uint32_t t = thread_arg(ARG(0));
  int state = rd16(t + TH_STATE);
  if (state == TS_RUNNING) {
    set_state(t, TS_STOPPED);
    leave_cpu();
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
  rt_cancel(wake_sleeper, t);
  if (h == running) {
    h->dead = 1;
    leave_cpu();
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
  (void)c;
  if (running && current == running) requeue_running();
}

// A thread that lowers itself to priority 0 is the idle loop: its code spins without calling the OS, so it
// is parked rather than resumed, and time advances while nothing else is runnable.
void rt_osSetThreadPri(Cpu *c) {
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
    leave_cpu();
  }
  yield_if_preempted();
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
static int wait_for_room(uint32_t q, uint32_t block) {
  while (rd32(q + MQ_VALID) >= rd32(q + MQ_COUNT)) {
    if (!block) return 0;
    block_on(q + MQ_FULL);
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
  if (!wait_for_room(q, ARG(2))) { RET(-1); return; }
  put(q, (rd32(q + MQ_FIRST) + rd32(q + MQ_VALID)) % rd32(q + MQ_COUNT), ARG(1));
  RET(0);
  yield_if_preempted();
}

void rt_osJamMesg(Cpu *c) {
  uint32_t q = ARG(0);
  if (!wait_for_room(q, ARG(2))) { RET(-1); return; }
  uint32_t count = rd32(q + MQ_COUNT);
  uint32_t first = (rd32(q + MQ_FIRST) + count - 1) % count;
  wr32(q + MQ_FIRST, first);
  put(q, first, ARG(1));
  RET(0);
  yield_if_preempted();
}

void rt_osRecvMesg(Cpu *c) {
  uint32_t q = ARG(0), out = ARG(1);
  while (rd32(q + MQ_VALID) == 0) {
    if (!ARG(2)) { RET(-1); return; }
    block_on(q + MQ_MT);
  }
  uint32_t first = rd32(q + MQ_FIRST);
  if (out) wr32(out, rd32(rd32(q + MQ_MSG) + 4 * first));
  wr32(q + MQ_FIRST, (first + 1) % rd32(q + MQ_COUNT));
  wr32(q + MQ_VALID, rd32(q + MQ_VALID) - 1);
  wake_first(q + MQ_FULL);
  RET(0);
  yield_if_preempted();
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
