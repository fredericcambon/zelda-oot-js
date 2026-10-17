// The virtual clock, the queue of timed device events, and the OS time routines built on them.
// Time is counted in Count ticks (RT_CPU_COUNTER per second) and only moves when the scheduler has nothing
// to run, when the host advances it, or when a polling call charges for itself.
#include "rt.h"

#define MAX_EVENTS 512
#define OS_TIMER_LIST 0x800068d0u // the list head a queued OSTimer points to

typedef struct Timed {
  uint64_t when;
  int kind;
  uint32_t a, b;
} Timed;

static Timed queue[MAX_EVENTS];
static uint32_t queued;
static uint64_t now;
static TimedFn user_event;

void rt_set_user_event(TimedFn fn) { user_event = fn; }

uint64_t rt_clock(void) { return now; }

void clock_set(uint64_t t) {
  if (t > now) now = t;
}

void rt_schedule(uint64_t when, int kind, uint32_t a, uint32_t b) {
  if (queued == MAX_EVENTS) rt_fatal("timed event queue is full");
  uint32_t k = queued++;
  // Events due at the same time run in the order they were scheduled.
  while (k > 0 && queue[k - 1].when > when) { queue[k] = queue[k - 1]; k--; }
  queue[k] = (Timed){ when, kind, a, b };
}

int rt_cancel(int kind, uint32_t a) {
  for (uint32_t k = 0; k < queued; k++) {
    if (queue[k].kind != kind || queue[k].a != a) continue;
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

static void run_event(const Timed *e) {
  switch (e->kind) {
    case TE_WAKE_SLEEPER: te_wake_sleeper(e->a, e->b); break;
    case TE_TIMER: te_timer(e->a, e->b); break;
    case TE_PI_DONE: te_pi_done(e->a, e->b); break;
    case TE_SI_DONE: te_si_done(e->a, e->b); break;
    case TE_VI_RETRACE: te_vi_retrace(e->a, e->b); break;
    case TE_RSP_EVENT: te_rsp_event(e->a, e->b); break;
    case TE_AI_FINISHED: te_ai_finished(e->a, e->b); break;
    case TE_USER: if (user_event) user_event(e->a, e->b); break;
    default: rt_fatal("timed event of unknown kind %d", e->kind);
  }
}

void events_run_due(void) {
  while (queued > 0 && queue[0].when <= now) {
    Timed e = queue[0];
    for (uint32_t k = 0; k + 1 < queued; k++) queue[k] = queue[k + 1];
    queued--;
    run_event(&e);
  }
}

void timers_reset(void) {
  now = 0;
  queued = 0;
  user_event = NULL;
}

// ---- OS routines ------------------------------------------------------------------------------------------

// A call that polls the clock costs a little time, so that a loop waiting on it makes progress.
#define POLL_CYCLES 16

void rt_osGetCount(Cpu *c) {
  rt_poll(c, BS_GETCOUNT, POLL_CYCLES);
  RET((uint32_t)now);
}

// 64-bit results come back in $v0 (high word) and $v1 (low word).
void rt_osGetTime(Cpu *c) {
  rt_poll(c, BS_GETTIME, POLL_CYCLES);
  c->r[2] = SX32((uint32_t)(now >> 32));
  c->r[3] = SX32((uint32_t)now);
}

// Nothing raises the Compare interrupt; timers are scheduled directly.
void rt_os_internal_set_compare(Cpu *c) { rt_mtc0(c, 11, ARG(0)); }

// OSTimer: next +0, prev +4, interval +8 (64-bit), value +0x10 (64-bit), queue +0x18, message +0x1c.
void te_timer(uint32_t timer, uint32_t unused) {
  (void)unused;
  uint64_t interval = rd64(timer + 8);
  mq_try_send(rd32(timer + 0x18), rd32(timer + 0x1c));
  if (interval == 0) {
    wr32(timer, 0);
    return;
  }
  uint64_t value = rd64(timer + 0x10) + interval;
  wr64(timer + 0x10, value);
  rt_schedule(value, TE_TIMER, timer, 0);
}

// osSetTimer(timer, countdown (a2:a3), interval (stack), queue, message)
void rt_osSetTimer(Cpu *c) {
  uint32_t timer = ARG(0);
  uint64_t countdown = ((uint64_t)ARG(2) << 32) | ARG(3);
  uint64_t interval = ((uint64_t)STACK_ARG(4) << 32) | STACK_ARG(5);
  if (rd32(timer) != 0) rt_cancel(TE_TIMER, timer);
  if (countdown == 0) countdown = interval;
  uint64_t value = now + countdown;
  wr32(timer, OS_TIMER_LIST);
  wr64(timer + 8, interval);
  wr64(timer + 0x10, value);
  wr32(timer + 0x18, STACK_ARG(6));
  wr32(timer + 0x1c, STACK_ARG(7));
  rt_schedule(value, TE_TIMER, timer, 0);
  RET(0);
}

// Returns -1 when the timer is not queued.
void rt_osStopTimer(Cpu *c) {
  uint32_t timer = ARG(0);
  if (rd32(timer) == 0) { RET(-1); return; }
  rt_cancel(TE_TIMER, timer);
  wr32(timer, 0);
  RET(0);
}

// ---- Saved state -------------------------------------------------------------------------------------------
// The clock, then the queued events in due order, each as (kind, a, b, due time).

int clock_save(Writer *w) {
  put64(w, now);
  put32(w, queued);
  for (uint32_t k = 0; k < queued; k++) {
    if (queue[k].kind == TE_USER) return rt_state_refuse("a host event is queued");
    put32(w, (uint32_t)queue[k].kind);
    put32(w, queue[k].a);
    put32(w, queue[k].b);
    put64(w, queue[k].when);
  }
  return 1;
}

static int known_kind(uint32_t kind) { return kind >= TE_WAKE_SLEEPER && kind <= TE_AI_FINISHED; }

int clock_load(Reader *r, int apply) {
  uint64_t t = get64(r);
  uint32_t n = get32(r);
  if (r->bad || n > MAX_EVENTS) return rt_state_refuse("the clock of the state is damaged");
  static Timed loaded[MAX_EVENTS];
  for (uint32_t k = 0; k < n; k++) {
    loaded[k].kind = (int)get32(r);
    loaded[k].a = get32(r);
    loaded[k].b = get32(r);
    loaded[k].when = get64(r);
    if (r->bad) return rt_state_refuse("the clock of the state is damaged");
    if (!known_kind((uint32_t)loaded[k].kind)) return rt_state_refuse("the state has a timed event of kind %d, which this build does not know", loaded[k].kind);
    if (k > 0 && loaded[k].when < loaded[k - 1].when) return rt_state_refuse("the timed events of the state are out of order");
  }
  if (apply) {
    now = t;
    queued = n;
    memcpy(queue, loaded, n * sizeof *loaded);
  }
  return 1;
}
