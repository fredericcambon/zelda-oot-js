// How much of the machine a build or a test run may use: a job cap, a gate that enforces it across builds, and the process priority.
import { availableParallelism, constants, getPriority, setPriority } from 'node:os';

/** `OOT_JOBS` when it is a positive integer, else a third of the cores (at least 2). */
export function jobLimit(env: NodeJS.ProcessEnv = process.env, cores = availableParallelism()): number {
  const set = Number(env.OOT_JOBS);
  return Number.isInteger(set) && set > 0 ? set : Math.max(2, Math.floor(cores / 3));
}

/** Runs `task` once fewer than `limit()` gated tasks are running; one gate per process, so concurrent builds share the cap. */
export function gate(limit: () => number = jobLimit): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    while (running >= limit()) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
    try {
      return await task();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}

/** Lowers this process, and so the children it starts, to below-normal priority; a lower priority already set is kept. */
export function lowerPriority(): void {
  try {
    if (getPriority() < constants.priority.PRIORITY_BELOW_NORMAL) setPriority(constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // The priority is a courtesy: a platform that refuses it still builds.
  }
}

/** The environment that bounds the threads Emscripten and Binaryen start themselves; a value already set wins. */
export function toolThreadEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, EMCC_CORES: env.EMCC_CORES ?? '4', BINARYEN_CORES: env.BINARYEN_CORES ?? '4' };
}
