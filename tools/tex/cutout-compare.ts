// `npx tsx tools/tex/cutout-compare.ts [--out out/tex-compare-cutout] [--chrome <path>] [--seconds 8] [--views a,b] [--timing-only]`: puts
// the game in the scene of save state 1 (Kokiri Forest, key 6 in `~/.zelda-oot-js/saves`, never written), walks Link to several
// views a fixed number of frames at a time (`?capture`, web/main.ts), and for each view takes a picture of the 3D canvas at 1920x1440
// with `cutout: smooth` and with `cutout: hard`, mip levels and MSAA on. Both pictures show the same game frame. It then measures
// the overlay's draw times in the running game for both modes. Needs `dist/` from `npm run port`. Pictures come from the ROM, so
// they stay under `out/`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { sleep, start, waitFor } from './cutout-lib.ts';

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: 'out/tex-compare-cutout' },
    port: { type: 'string', default: process.env.PORT ?? '5299' },
    chrome: { type: 'string', default: 'C:/Program Files/Google/Chrome/Application/chrome.exe' },
    seconds: { type: 'string', default: '8' },
    views: { type: 'string', default: '' },
    'timing-only': { type: 'boolean', default: false },
  },
});
const port = Number(values.port);

/** The stick held for `frames` game frames (up is positive y). */
type Step = [x: number, y: number, frames: number];
interface View {
  name: string;
  steps: Step[];
}

const R: Step = [80, 0, 150], U: Step = [0, 80, 150], D: Step = [0, -80, 180], L: Step = [-80, 0, 240];
const VIEWS: View[] = [
  { name: 'v1-house', steps: [] },
  { name: 'v2-fence', steps: [R, U] },
  { name: 'v3-bush', steps: [R, U, R, D] },
  { name: 'v4-lattice', steps: [R, U, R, D, L, U] },
  { name: 'v5-bushes-wide', steps: [R, U, R] },
  { name: 'v6-gate', steps: [R, U, R, D, L] },
  { name: 'v7-distant', steps: [R, U, R, D, [0, -80, 180]] },
];

const outDir = values.out!;
mkdirSync(outDir, { recursive: true });
const s = await start(port, values.chrome!);
try {
  const { cdp } = s;
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
  const call = <T = Record<string, unknown>>(m: string, p: object = {}) => cdp.send<T>(m, p, sessionId);
  const ev = async (e: string) => (await call<{ result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value;
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 2, mobile: false });
  await call('Page.navigate', { url: `http://localhost:${port}/` });
  await waitFor('page', async () => ((await ev('document.readyState')) === 'complete' ? true : undefined));
  await ev("localStorage.setItem('zelda-oot-js:60hz','1'); localStorage.setItem('oot.gfx', JSON.stringify({ cutout: 'smooth' }))");

  const open = async (query: string) => {
    await call('Page.navigate', { url: `http://localhost:${port}/?${query}#debug` });
    // A page in capture mode shows no picture before the first step.
    await waitFor('the game', async () => ((await ev("typeof globalThis.ootStep === 'function' || globalThis.ootTiming?.firstFrame !== undefined")) && /frame \d+/.test(await overlay()) ? true : undefined));
    await sleep(500);
  };
  const key = async (k: string, code: string, ms = 50) => {
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, text: k.length === 1 ? k : undefined });
    await sleep(ms);
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code });
  };
  const overlay = async () => String(await ev("document.getElementById('overlay').textContent"));
  const mode = async () => /cutout (\w+)/.exec(await overlay())?.[1];
  const setMode = async (want: 'smooth' | 'hard') => {
    if ((await mode()) !== want) await key('v', 'KeyV');
    await waitFor(`cutout ${want}`, async () => ((await mode()) === want ? true : undefined));
  };
  const shot = async (name: string) => {
    const png = (await ev("document.getElementById('screen').toDataURL('image/png')")) as string;
    writeFileSync(join(outDir, `${name}.png`), Buffer.from(png.split(',')[1]!, 'base64'));
  };

  if (!values['timing-only']) {
    await open('capture');
    const walk = async (view: View) => {
      await key('6', 'Digit6');
      await sleep(1500);
      for (const [x, y, frames] of [...view.steps, [0, 0, 90] as Step]) await ev(`globalThis.ootStep(${frames}, ${x}, ${y})`);
    };
    const only = values.views ? values.views.split(',') : null;
    for (const view of VIEWS.filter((v) => !only || only.includes(v.name))) {
      for (const m of ['smooth', 'hard'] as const) {
        await setMode(m);
        // The first walk starts the programs for this view (mip-level ones build in the background); the second draws with them.
        await walk(view);
        await sleep(5000);
        await walk(view);
        await shot(`${view.name}-${m}`);
      }
      console.log(`${view.name} captured`);
    }
  }

  // Draw times: the game runs at its own pace in the scene of the state; the two modes alternate, one sample a second.
  await open('bench');
  await key('6', 'Digit6');
  await sleep(3000);
  const num = (text: string, re: RegExp) => Number(re.exec(text)?.[1] ?? NaN);
  const sample = async () => {
    const t = await overlay();
    return { lists: num(t, /display lists\s+([\d.]+)/), submit: num(t, /submit\s+([\d.]+)/), gpu: num(t, /GPU\s+([\d.]+)/), calls: num(t, /draw calls\s+([\d.]+)/), fps: num(t, /^(\d+) fps/m) };
  };
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const rows: Record<string, Awaited<ReturnType<typeof sample>>[]> = { hard: [], smooth: [] };
  for (const round of ['hard', 'smooth', 'hard', 'smooth'] as const) {
    await setMode(round);
    await sleep(4000);
    for (let i = 0; i < Number(values.seconds); i++) {
      await sleep(1000);
      rows[round]!.push(await sample());
    }
  }
  console.log('| cutout | fps | display lists ms | submit ms | GPU ms | draw calls |');
  for (const m of ['hard', 'smooth']) {
    const r = rows[m]!;
    console.log(`| ${m} | ${mean(r.map((x) => x.fps)).toFixed(1)} | ${mean(r.map((x) => x.lists)).toFixed(2)} | ${mean(r.map((x) => x.submit)).toFixed(2)} | ${mean(r.map((x) => x.gpu)).toFixed(2)} | ${mean(r.map((x) => x.calls)).toFixed(0)} |`);
  }
} finally {
  await s.stop();
  setTimeout(() => process.exit(0), 500);
}
