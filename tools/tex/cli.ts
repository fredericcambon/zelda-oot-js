// `npm run tex -- <dump|upscale|compare> [options]`: the texture replacement trial (docs/texture-pack.md). Everything it writes is under out/.
import { parseArgs } from 'node:util';
import { dump } from './dump.ts';
import { defaultPython, defaultToolDir, upscale } from './upscale.ts';

const USAGE = `usage: tex dump [--dist dist] [--out out/texdump]
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
      port: { type: 'string', default: process.env.PORT ?? '5399' },
    },
  });
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
