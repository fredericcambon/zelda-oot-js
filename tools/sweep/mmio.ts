// Names of the memory-mapped hardware registers, from the register maps on n64brew.dev. Physical addresses.

const REGISTERS: Record<string, string[]> = {
  '03f00000': ['RDRAM_CONFIG', 'RDRAM_DEVICE_ID', 'RDRAM_DELAY', 'RDRAM_MODE', 'RDRAM_REF_INTERVAL', 'RDRAM_REF_ROW', 'RDRAM_RAS_INTERVAL', 'RDRAM_MIN_INTERVAL', 'RDRAM_ADDR_SELECT', 'RDRAM_DEVICE_MANUF'],
  '04000000': ['SP_DMEM'],
  '04001000': ['SP_IMEM'],
  '04040000': ['SP_MEM_ADDR', 'SP_DRAM_ADDR', 'SP_RD_LEN', 'SP_WR_LEN', 'SP_STATUS', 'SP_DMA_FULL', 'SP_DMA_BUSY', 'SP_SEMAPHORE'],
  '04080000': ['SP_PC'],
  '04100000': ['DPC_START', 'DPC_END', 'DPC_CURRENT', 'DPC_STATUS', 'DPC_CLOCK', 'DPC_BUFBUSY', 'DPC_PIPEBUSY', 'DPC_TMEM'],
  '04200000': ['DPS_TBIST', 'DPS_TEST_MODE', 'DPS_BUFTEST_ADDR', 'DPS_BUFTEST_DATA'],
  '04300000': ['MI_MODE', 'MI_VERSION', 'MI_INTERRUPT', 'MI_MASK'],
  '04400000': ['VI_STATUS', 'VI_ORIGIN', 'VI_WIDTH', 'VI_V_INTR', 'VI_CURRENT', 'VI_BURST', 'VI_V_SYNC', 'VI_H_SYNC', 'VI_LEAP', 'VI_H_START', 'VI_V_START', 'VI_V_BURST', 'VI_X_SCALE', 'VI_Y_SCALE'],
  '04500000': ['AI_DRAM_ADDR', 'AI_LEN', 'AI_CONTROL', 'AI_STATUS', 'AI_DACRATE', 'AI_BITRATE'],
  '04600000': ['PI_DRAM_ADDR', 'PI_CART_ADDR', 'PI_RD_LEN', 'PI_WR_LEN', 'PI_STATUS', 'PI_BSD_DOM1_LAT', 'PI_BSD_DOM1_PWD', 'PI_BSD_DOM1_PGS', 'PI_BSD_DOM1_RLS', 'PI_BSD_DOM2_LAT', 'PI_BSD_DOM2_PWD', 'PI_BSD_DOM2_PGS', 'PI_BSD_DOM2_RLS'],
  '04700000': ['RI_MODE', 'RI_CONFIG', 'RI_CURRENT_LOAD', 'RI_SELECT', 'RI_REFRESH', 'RI_LATENCY', 'RI_RERROR', 'RI_WERROR'],
  '04800000': ['SI_DRAM_ADDR', 'SI_PIF_ADDR_RD64B', 'SI_RESERVED_0', 'SI_RESERVED_1', 'SI_PIF_ADDR_WR64B', 'SI_RESERVED_2', 'SI_STATUS'],
};

/** Register name for a physical address, or a region name for the ranges that are memory-like. */
export function registerName(physical: number): string {
  const p = physical >>> 0;
  for (const [base, names] of Object.entries(REGISTERS)) {
    const offset = p - parseInt(base, 16);
    if (offset < 0) continue;
    if (names.length === 1 && offset < 0x1000) return offset === 0 ? names[0]! : `${names[0]}+0x${offset.toString(16)}`;
    if (names.length > 1 && offset % 4 === 0 && offset / 4 < names.length) return names[offset / 4]!;
  }
  if (p >= 0x1fc00000 && p < 0x1fc007c0) return 'PIF_ROM';
  if (p >= 0x1fc007c0 && p < 0x1fc00800) return `PIF_RAM+0x${(p - 0x1fc007c0).toString(16)}`;
  if (p >= 0x08000000 && p < 0x10000000) return `CART_DOMAIN2 (SRAM or flash)+0x${(p - 0x08000000).toString(16)}`;
  if (p >= 0x10000000 && p < 0x1fc00000) return `CART_ROM+0x${(p - 0x10000000).toString(16)}`;
  if (p >= 0x05000000 && p < 0x06000000) return `CART_DOMAIN1_ADDR1+0x${(p - 0x05000000).toString(16)}`;
  return `0x${p.toString(16)}`;
}

/** Whether an effective address (any segment) lies in the memory-mapped I/O or cartridge ranges rather than in RDRAM. */
export function isMmio(ea: number): boolean {
  const a = ea >>> 0;
  if (a < 0x80000000 || a >= 0xc0000000) return false;
  const p = a & 0x1fffffff;
  return p >= 0x03f00000 && p < 0x1fc00800;
}
