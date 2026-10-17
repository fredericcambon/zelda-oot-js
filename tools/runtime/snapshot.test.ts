import { describe, expect, it } from 'vitest';
import { compressState, decompressState, loadState, saveState, stateFormat, STATE_VERSION, type StateCore } from './snapshot.ts';

const ERROR_AT = 0x10;

/** A module whose runtime refuses (when `error` is set) or whose state is the 12 bytes given. */
function fakeModule(state: Uint8Array, error = ''): StateCore & { loaded: Uint8Array | null; frees: number[] } {
  const text = new TextEncoder().encode(error + '\0');
  const m = {
    HEAPU8: new Uint8Array(0x1000),
    loaded: null as Uint8Array | null,
    frees: [] as number[],
    _malloc: () => 0x100,
    _free: (p: number) => void m.frees.push(p),
    _oot_state_save(buf: number, cap: number) {
      if (error) return 0;
      if (buf) {
        expect(cap).toBe(state.length);
        m.HEAPU8.set(state, buf);
      }
      return state.length;
    },
    _oot_state_load(buf: number, len: number) {
      m.loaded = m.HEAPU8.slice(buf, buf + len);
    },
    _oot_state_loaded: () => (error ? 0 : 1),
    _oot_state_error: () => ERROR_AT,
    UTF8ToString: (p: number) => (p === ERROR_AT ? error : ''),
  };
  m.HEAPU8.set(text, ERROR_AT);
  return m as unknown as StateCore & { loaded: Uint8Array | null; frees: number[] };
}

function header(magic: string, version: number): Uint8Array {
  const out = new Uint8Array(12);
  out.set(new TextEncoder().encode(magic));
  new DataView(out.buffer).setUint32(4, version, true);
  return out;
}

describe('portable states', () => {
  it('reads the format of a state from its first bytes', () => {
    expect(stateFormat(header('OOTP', STATE_VERSION))).toEqual({ kind: 'portable', version: STATE_VERSION });
    expect(stateFormat(header('OOTP', 7))).toEqual({ kind: 'portable', version: 7 });
    // The raw memory dump of the earlier format starts with "OOTS" written big-endian.
    expect(stateFormat(header('OOTS', 0))).toEqual({ kind: 'old' });
    expect(stateFormat(header('junk', 1))).toEqual({ kind: 'unknown' });
    expect(stateFormat(new Uint8Array(3))).toEqual({ kind: 'unknown' });
  });

  it('copies the state out of the module and frees its buffer', () => {
    const state = header('OOTP', STATE_VERSION);
    const mod = fakeModule(state);
    expect(saveState(mod)).toEqual(state);
    expect(mod.frees).toEqual([0x100]);
  });

  it('throws the runtime\'s reason when a state is not saved or not loaded', async () => {
    const mod = fakeModule(new Uint8Array(0), 'the game is still booting');
    expect(() => saveState(mod)).toThrow('still booting');
    await expect(loadState(mod, header('OOTP', 9))).rejects.toThrow('still booting');
    expect(mod.frees).toEqual([0x100]);
  });

  it('hands a state to the module as it is', async () => {
    const state = header('OOTP', STATE_VERSION);
    const mod = fakeModule(state);
    await loadState(mod, state);
    expect(mod.loaded).toEqual(state);
  });

  it('round-trips through gzip', async () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 7) & 0xff);
    const packed = await compressState(bytes);
    expect(packed.length).toBeLessThan(bytes.length);
    expect(await decompressState(packed)).toEqual(bytes);
  });
});
