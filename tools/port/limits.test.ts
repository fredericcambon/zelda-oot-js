import { describe, expect, it } from 'vitest';
import { gate, jobLimit, toolThreadEnv } from './limits.ts';

describe('jobLimit', () => {
  it('is a third of the cores, at least 2', () => {
    expect(jobLimit({}, 24)).toBe(8);
    expect(jobLimit({}, 4)).toBe(2);
    expect(jobLimit({}, 1)).toBe(2);
  });

  it('takes OOT_JOBS when it is a positive integer', () => {
    expect(jobLimit({ OOT_JOBS: '3' }, 24)).toBe(3);
    expect(jobLimit({ OOT_JOBS: '0' }, 24)).toBe(8);
    expect(jobLimit({ OOT_JOBS: 'many' }, 24)).toBe(8);
    expect(jobLimit({ OOT_JOBS: '2.5' }, 24)).toBe(8);
  });
});

describe('gate', () => {
  it('never runs more tasks at once than the limit, across callers', async () => {
    const run = gate(() => 3);
    let running = 0;
    let peak = 0;
    const task = async () => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
    };
    await Promise.all(Array.from({ length: 20 }, () => run(task)));
    expect(peak).toBe(3);
  });

  it('releases the slot of a failed task', async () => {
    const run = gate(() => 1);
    await expect(run(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(run(async () => 1)).resolves.toBe(1);
  });
});

describe('toolThreadEnv', () => {
  it('defaults both to 4 and keeps what is set', () => {
    expect(toolThreadEnv({})).toMatchObject({ EMCC_CORES: '4', BINARYEN_CORES: '4' });
    expect(toolThreadEnv({ EMCC_CORES: '2' })).toMatchObject({ EMCC_CORES: '2', BINARYEN_CORES: '4' });
  });
});
