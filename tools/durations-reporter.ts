// A vitest reporter that writes the duration of each test file, in seconds, to out/test-durations.json so that runs can be compared.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import type { Reporter, TestModule } from 'vitest/node';

export const DURATIONS_FILE = resolve('out', 'test-durations.json');

export default class DurationsReporter implements Reporter {
  private readonly started = performance.now();

  onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
    const files: [string, number][] = modules.map((m) => [relative(process.cwd(), m.moduleId).replaceAll('\\', '/'), Math.round(m.diagnostic().duration) / 1000]);
    files.sort((a, b) => b[1] - a[1]);
    mkdirSync(dirname(DURATIONS_FILE), { recursive: true });
    writeFileSync(DURATIONS_FILE, JSON.stringify({ wallSeconds: Math.round(performance.now() - this.started) / 1000, files: Object.fromEntries(files) }, null, 2));
  }
}
