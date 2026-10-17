// The cartridge: ROM reads and the save memory behind the PI bus, and the PI DMA the game requests through
// osEPiStartDma. A transfer is carried out when its time has come and then reported as a message on the
// reply queue named in the request, as the original PI manager thread does.
#include "rt.h"

#define OS_PI_ACTIVE 0x80006890u  // non-zero once osCreatePiManager has run
#define OS_PI_CMDQUEUE 0x80006898u

// OSPiHandle: the KSEG1 base address of the device sits at +0xc.
#define PIH_BASE 0x0c
// OSIoMesg: header type +0 (halfword), priority +2, status +3, reply queue +4; then RAM, device, size, handle.
#define IO_TYPE 0x00
#define IO_STATUS 0x03
#define IO_RETQUEUE 0x04
#define IO_DRAM 0x08
#define IO_DEVADDR 0x0c
#define IO_SIZE 0x10
#define IO_HANDLE 0x14
#define IO_TYPE_READ 15
#define IO_TYPE_WRITE 16

#define CART_SRAM 0x08000000u // save memory window
#define CART_ROM 0x10000000u  // cartridge ROM window
#define CART_END 0x1fc00000u

static const uint8_t *rom;
static size_t rom_size;
static uint8_t sram[RT_SRAM_SIZE];
static int sram_dirty;
static uint64_t pi_free_at;

void rt_rom_set(const uint8_t *data, size_t size) {
  rom = data;
  rom_size = size;
}

uint8_t *rt_sram(size_t *size) {
  if (size) *size = sizeof sram;
  return sram;
}

int rt_sram_take_dirty(void) {
  int d = sram_dirty;
  sram_dirty = 0;
  return d;
}

void pi_reset(void) {
  pi_free_at = 0;
  sram_dirty = 0;
}

static uint32_t cart_phys(uint32_t handle, uint32_t dev) { return (rd32(handle + PIH_BASE) | dev) & 0x1fffffffu; }

// Copies between RDRAM and the cartridge; `write` stores into the save memory (the ROM is read-only).
static void cart_copy(uint32_t phys, uint32_t ram, uint32_t size, int write) {
  if (phys >= CART_SRAM && phys < CART_ROM) {
    uint32_t off = phys - CART_SRAM;
    if ((uint64_t)off + size > sizeof sram) rt_fatal("save memory access 0x%08x+0x%x is outside the %u-byte store", phys, size, (unsigned)sizeof sram);
    for (uint32_t k = 0; k < size; k++) {
      if (write) sram[off + k] = rd8(ram + k);
      else wr8(ram + k, sram[off + k]);
    }
    if (write) sram_dirty = 1;
  } else if (phys >= CART_ROM && phys < CART_END) {
    if (write) return;
    uint32_t off = phys - CART_ROM;
    for (uint32_t k = 0; k < size; k++) wr8(ram + k, off + k < rom_size ? rom[off + k] : 0);
  } else {
    rt_fatal("PI access to unmapped cartridge address 0x%08x", phys);
  }
}

void rt_osCreatePiManager(Cpu *c) {
  uint32_t queue = ARG(1);
  mq_init(queue, ARG(2), ARG(3));
  wr32(OS_PI_CMDQUEUE, queue);
  wr32(OS_PI_ACTIVE, 1);
}

void rt_osPiGetCmdQueue(Cpu *c) { RET(rd32(OS_PI_ACTIVE) ? rd32(OS_PI_CMDQUEUE) : 0); }

void te_pi_done(uint32_t mesg, uint32_t unused) {
  (void)unused;
  uint32_t handle = rd32(mesg + IO_HANDLE);
  cart_copy(cart_phys(handle, rd32(mesg + IO_DEVADDR)), rd32(mesg + IO_DRAM), rd32(mesg + IO_SIZE), rd16(mesg + IO_TYPE) == IO_TYPE_WRITE);
  wr8(mesg + IO_STATUS, 0);
  mq_try_send(rd32(mesg + IO_RETQUEUE), mesg);
}

// osEPiStartDma(handle, request, direction): -1 without a PI manager, else the request is queued and its
// completion is reported later. Requests complete in the order they are made.
void rt_osEPiStartDma(Cpu *c) {
  uint32_t handle = ARG(0), mesg = ARG(1), dir = ARG(2);
  if (!rd32(OS_PI_ACTIVE)) { RET(-1); return; }
  wr32(mesg + IO_HANDLE, handle);
  wr16(mesg + IO_TYPE, dir == 0 ? IO_TYPE_READ : IO_TYPE_WRITE);
  uint64_t start = rt_clock() > pi_free_at ? rt_clock() : pi_free_at;
  pi_free_at = start + PI_SETUP_CYCLES + (uint64_t)rd32(mesg + IO_SIZE) * PI_CYCLES_PER_BYTE;
  rt_schedule(pi_free_at, TE_PI_DONE, mesg, 0);
  RET(0);
}

// osEPiReadIo(handle, device address, word out) and osEPiWriteIo(handle, device address, word): one word,
// carried out at once.
void rt_osEPiReadIo(Cpu *c) {
  uint32_t out = ARG(2);
  cart_copy(cart_phys(ARG(0), ARG(1)), out, 4, 0);
  RET(0);
}

void rt_osEPiWriteIo(Cpu *c) {
  uint32_t phys = cart_phys(ARG(0), ARG(1)), v = ARG(2);
  if (phys >= CART_SRAM && phys < CART_ROM) {
    uint32_t off = phys - CART_SRAM;
    if ((uint64_t)off + 4 > sizeof sram) rt_fatal("save memory access 0x%08x is outside the store", phys);
    for (int k = 0; k < 4; k++) sram[off + k] = (uint8_t)(v >> (24 - 8 * k));
    sram_dirty = 1;
  }
  RET(0);
}

// ---- Saved state -------------------------------------------------------------------------------------------
// The save memory is not part of a state.

int pi_save(Writer *w) {
  put64(w, pi_free_at);
  return 1;
}

int pi_load(Reader *r, int apply) {
  uint64_t t = get64(r);
  if (r->bad) return rt_state_refuse("the cartridge interface state is damaged");
  if (apply) pi_free_at = t;
  return 1;
}
