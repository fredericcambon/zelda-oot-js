// Controllers. The PIF transfers of the original become a latch of the host's pad state and a completion
// event on the serial interface.
#include "rt.h"

#define CHANNELS 4
#define CONT_TYPE_NORMAL 0x0005u
#define CONT_NO_RESPONSE 0x08u

typedef struct Pad {
  uint16_t buttons;
  int8_t x, y;
} Pad;

static unsigned connected = 1;
static Pad host_pad[CHANNELS];
static Pad latched[CHANNELS];
static int initialised;

void cont_reset(void) {
  connected = 1;
  initialised = 0;
  memset(host_pad, 0, sizeof host_pad);
  memset(latched, 0, sizeof latched);
}

void rt_pad_connect(unsigned mask) { connected = mask & ((1u << CHANNELS) - 1); }

void rt_pad_set(unsigned port, uint16_t buttons, int8_t x, int8_t y) {
  if (port < CHANNELS) host_pad[port] = (Pad){ buttons, x, y };
}

// OSContStatus: type +0 (halfword), status +2, error +3. The entry of a missing controller only gets the error.
static void write_status(uint32_t status) {
  for (unsigned ch = 0; ch < CHANNELS; ch++, status += 4) {
    if (connected & (1u << ch)) {
      wr16(status, CONT_TYPE_NORMAL);
      wr8(status + 2, 0);
      wr8(status + 3, 0);
    } else {
      wr8(status + 3, CONT_NO_RESPONSE);
    }
  }
}

// osContInit(queue, bit pattern out, OSContStatus[4] out): waits until half a second after reset, then
// reports the connected controllers. Only the first call does anything.
void rt_osContInit(Cpu *c) {
  if (initialised) { RET(0); return; }
  initialised = 1;
  thread_sleep_until(RT_CPU_COUNTER / 2);
  write_status(ARG(2));
  if (ARG(1)) wr8(ARG(1), (uint8_t)connected);
  RET(0);
}

// The completion of a transfer is signalled through the SI event the game registered, or straight to the
// queue passed to the call when it registered none.
static void si_done(uint32_t queue, uint32_t unused) {
  (void)unused;
  if (rd32(OS_EVENT_TABLE + 8 * EVENT_SI)) event_send(EVENT_SI);
  else mq_try_send(queue, 0);
}

// The original sends the request to the PIF and waits for the first completion on the queue, then starts the
// read; the second completion is the one the game waits for.
static void transfer(Cpu *c, uint32_t queue, int read) {
  rt_schedule(rt_clock() + SI_CYCLES, si_done, queue, 0);
  c->r[4] = SX32(queue);
  c->r[5] = 0;
  c->r[6] = OS_MESG_BLOCK;
  rt_osRecvMesg(c);
  if (read) memcpy(latched, host_pad, sizeof latched);
  rt_schedule(rt_clock() + SI_CYCLES, si_done, queue, 0);
}

void rt_osContStartReadData(Cpu *c) { transfer(c, ARG(0), 1); }
void rt_osContStartQuery(Cpu *c) { transfer(c, ARG(0), 0); }

// OSContPad: buttons +0 (halfword), stick x +2, stick y +3, error +4; six bytes each.
void rt_osContGetReadData(Cpu *c) {
  uint32_t pad = ARG(0);
  for (unsigned ch = 0; ch < CHANNELS; ch++, pad += 6) {
    if (connected & (1u << ch)) {
      wr16(pad, latched[ch].buttons);
      wr8(pad + 2, (uint8_t)latched[ch].x);
      wr8(pad + 3, (uint8_t)latched[ch].y);
      wr8(pad + 4, 0);
    } else {
      wr8(pad + 4, CONT_NO_RESPONSE);
    }
  }
}

void rt_osContGetQuery(Cpu *c) { write_status(ARG(0)); }
