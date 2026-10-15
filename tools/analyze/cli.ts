import { parseArgs } from 'node:util';
import { analyze } from './run.ts';
import { romPathFromEnv } from './context.ts';

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      rom: { type: 'string' },
      out: { type: 'string', default: 'out' },
      work: { type: 'string', default: 'rea-work' },
      'no-ghidra': { type: 'boolean', default: false },
      'force-ghidra': { type: 'boolean', default: false },
      'coverage-doc': { type: 'string', default: 'docs/re/coverage.md' },
      shards: { type: 'string' },
    },
  });
  try {
    await analyze({
      romPath: romPathFromEnv(values.rom),
      outDir: values.out!,
      workDir: values.work!,
      useGhidra: !values['no-ghidra'],
      forceGhidra: values['force-ghidra'],
      coverageDoc: values['coverage-doc'],
      shards: values.shards ? Number(values.shards) : undefined,
      log: (m) => console.log(m),
    });
    return 0;
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

process.exitCode = await main();
