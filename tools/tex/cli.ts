// `npm run tex -- <dump|upscale|compare> [options]`: the texture replacement trial (docs/texture-pack.md). Everything it writes is under out/.
import { parseArgs } from 'node:util';
import { dump } from './dump.ts';
import { defaultPython, defaultToolDir, upscale } from './upscale.ts';

const USAGE = `usage: tex dump [--dist dist] [--out out/texdump] [--all [--frames 600] [--entrances 238,626] [--fresh] [--hang 120]]
       tex upscale [--dump out/texdump] [--out out/texpack] [--tool <dir>] [--python <exe>] [--variants a,b,c,d] [--pad 16] [--limit N]
       tex compare [--out out/tex-compare] [--pack out/texpack] [--variants a,b,c,d] [--chrome <path>]`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      dist: { type: 'string', default: 'dist' },
      out: { type: 'string' },
      dump: { type: 'string', default: 'out/texdump' },
      tool: { type: 'string', default: defaultToolDir() },
      python: { type: 'string', default: defaultPython() },
      variants: { type: 'string' },
      pad: { type: 'string', default: '16' },
      limit: { type: 'string' },
      pack: { type: 'string', default: 'out/texpack' },
      chrome: { type: 'string', default: 'C:/Program Files/Google/Chrome/Application/chrome.exe' },
      all: { type: 'boolean', default: false },
      worker: { type: 'boolean', default: false },
      hang: { type: 'string', default: '120' },
      fresh: { type: 'boolean', default: false },
      frames: { type: 'string', default: '600' },
      entrances: { type: 'string' },
      port: { type: 'string', default: process.env.PORT ?? '5399' },
    },
  });
  if (command === 'dump' && values.all) {
    const { dumpAll, superviseDumpAll } = await import('./dump-all.ts');
    const options = { dist: values.dist!, out: values.out ?? 'out/texdump', frames: Number(values.frames), entrances: values.entrances?.split(',').map(Number) };
    if (values.worker) await dumpAll(options);
    else {
      const forward = ['dist', 'out', 'frames', 'entrances'].flatMap((k) => (values[k as 'dist'] === undefined ? [] : [`--${k}`, values[k as 'dist']!]));
      await superviseDumpAll({ ...options, fresh: values.fresh, hangSeconds: Number(values.hang), workerArgs: forward });
    }
    return 0;
  }
  if (command === 'dump') {
    await dump({ dist: values.dist!, out: values.out ?? 'out/texdump' });
    return 0;
  }
  if (command === 'upscale') {
    upscale({ dump: values.dump!, out: values.out ?? 'out/texpack', tool: values.tool!, python: values.python!, variants: values.variants?.split(','), pad: Number(values.pad), limit: values.limit === undefined ? undefined : Number(values.limit) });
    return 0;
  }
  if (command === 'compare') {
    const { compare } = await import('./compare.ts');
    await compare({ out: values.out ?? 'out/tex-compare', pack: values.pack!, dump: values.dump!, variants: values.variants?.split(','), chrome: values.chrome!, port: Number(values.port) });
    return 0;
  }
  console.error(USAGE);
  return 1;
}

process.exitCode = await main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  return 1;
});
