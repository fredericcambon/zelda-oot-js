import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadContext, romPathFromEnv } from '../analyze/context.ts';
import type { Inventory } from '../analyze/types.ts';
import { generate } from './generate.ts';

const { values } = parseArgs({
  options: {
    rom: { type: 'string' },
    inventory: { type: 'string', default: 'out/inventory.json' },
    out: { type: 'string', default: 'generated/c' },
  },
});
try {
  const ctx = loadContext(romPathFromEnv(values.rom));
  const inv = JSON.parse(readFileSync(values.inventory!, 'utf8')) as Inventory;
  const r = generate(ctx, inv, values.out!);
  console.log(`recompiled ${r.functions} functions into ${r.files.length} files in ${values.out} (${r.osBindings} OS routine bindings)`);
  if (r.problems.length > 0) {
    for (const p of r.problems.slice(0, 40)) console.error(`problem: ${p}`);
    console.error(`${r.problems.length} problems`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
