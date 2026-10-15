// The virtual clock, the queue of timed device events, and the OS time routines built on them.
// Time is counted in Count ticks (RT_CPU_COUNTER per second) and only moves when the scheduler has nothing
// to run, when the host advances it, or when a polling call charges for itself.
#include "rt.h"

#define MAX_EVENTS 512
#define OS_TIMER_LIST 0x800068d0u // the list head a queued OSTimer points to

typedef struct Timed {
  uint64_t when, seq;
  TimedFn fn;
  uint32_t a, b;
} Timed;

static Timed queue[MAX_EVENTS];
static uint32_t queued;
static uint64_t seq;
static uint64_t now;

uint64_t rt_clock(void) { return now; }

void clock_set(uint64_t t) {
  if (t > now) now = t;
}

void rt_schedule(uint64_t when, TimedFn fn, uint32_t a, uint32_t b) {
  if (queued == MAX_EVENTS) rt_fatal("timed event queue is full");
  uint32_t k = queued++;
  // Events due at the same time run in the order they were scheduled.
  while (k > 0 && queue[k - 1].when > when) { queue[k] = queue[k - 1]; k--; }
  queue[k] = (Timed){ when, seq++, fn, a, b };
}

int rt_cancel(TimedFn fn, uint32_t a) {
  for (uint32_t k = 0; k < queued; k++) {
    if (queue[k].fn != fn || queue[k].a != a) continue;
    for (; k + 1 < queued; k++) queue[k] = queue[k + 1];
    queued--;
    return 1;
  }
  return 0;
}

int rt_next_event(uint64_t *when) {
  if (queued == 0) return 0;
  *when = queue[0].when;
  return 1;
}

void events_run_due(void) {
  while (queued > 0 && queue[0].when <= now) {
    Timed e = queue[0];
    for (uint32_t k = 0; k + 1 < queued; k++) queue[k] = queue[k + 1];
    queued--;
    e.fn(e.a, e.b);
  }
}

void timers_reset(void) {
  now = 0;
  queued = 0;
  seq = 0;
}

// ---- OS routines ------------------------------------------------------------------------------------------

// A call that polls the clock costs a little time, so that a loop waiting on it makes progress.
#define POLL_CYCLES 16

void rt_osGetCount(Cpu *c) {
  rt_poll(POLL_CYCLES);
  RET((uint32_t)now);
}

// 64-bit results come back in $v0 (high word) and $v1 (low word).
void rt_osGetTime(Cpu *c) {
  rt_poll(POLL_CYCLES);
  c->r[2] = SX32((uint32_t)(now >> 32));
  c->r[3] = SX32((uint32_t)now);
}

// Nothing raises the Compare interrupt; timers are scheduled directly.
void rt_os_internal_set_compare(Cpu *c) { rt_mtc0(c, 11, ARG(0)); }

// OSTimer: next +0, prev +4, interval +8 (64-bit), value +0x10 (64-bit), queue +0x18, message +0x1c.
static void timer_fire(uint32_t timer, uint32_t unused) {
  (void)unused;
  uint64_t interval = rd64(timer + 8);
  mq_try_send(rd32(timer + 0x18), rd32(timer + 0x1c));
  if (interval == 0) {
    wr32(timer, 0);
    return;
  }
  uint64_t value = rd64(timer + 0x10) + interval;
  wr64(timer + 0x10, value);
  rt_schedule(value, timer_fire, timer, 0);
}

// osSetTimer(timer, countdown (a2:a3), interval (stack), queue, message)
void rt_osSetTimer(Cpu *c) {
  uint32_t timer = ARG(0);
  uint64_t countdown = ((uint64_t)ARG(2) << 32) | ARG(3);
  uint64_t interval = ((uint64_t)STACK_ARG(4) << 32) | STACK_ARG(5);
  if (rd32(timer) != 0) rt_cancel(timer_fire, timer);
  if (countdown == 0) countdown = interval;
  uint64_t value = now + countdown;
  wr32(timer, OS_TIMER_LIST);
  wr64(timer + 8, interval);
  wr64(timer + 0x10, value);
  wr32(timer + 0x18, STACK_ARG(6));
  wr32(timer + 0x1c, STACK_ARG(7));
  rt_schedule(value, timer_fire, timer, 0);
  RET(0);
}

// Returns -1 when the timer is not queued.
void rt_osStopTimer(Cpu *c) {
  uint32_t timer = ARG(0);
  if (rd32(timer) == 0) { RET(-1); return; }
  rt_cancel(timer_fire, timer);
  wr32(timer, 0);
  RET(0);
}
