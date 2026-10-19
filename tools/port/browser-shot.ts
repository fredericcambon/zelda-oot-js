// `npx tsx tools/port/browser-shot.ts --query "file=1,warp=0x422" --out out/shots/name [--settings '{"ao":false}'] [--seconds 20] [--every 2] [--eval "js"]`:
// runs the dev server and headless Chrome (muted), opens the page with the query, and saves a picture of the canvas every few seconds
// (`<out>-<seconds>.png`). `--settings` is merged over the default graphics settings (localStorage `oot.gfx`). `--ls key=value;key=value` sets other localStorage keys (`oot.smooth=0`), `--save-at <seconds>` presses 5 (save state to the current slot; set OOT_SAVES_DIR so the user's folder is untouched), `--eval <global>` writes JSON.stringify(globalThis.<global>) after each shot and its result goes to `<out>-<seconds>.txt`.
// Needs `dist/` from `npm run port`. Pictures come from the ROM: keep them under `out/`.
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { Cdp, CHROME_SILENT_FLAGS, sleep, waitFor } from './cdp.ts';

const { values } = parseArgs({
  options: {
    query: { type: 'string', default: '' },
    out: { type: 'string' },
    settings: { type: 'string', default: '{}' },
    seconds: { type: 'string', default: '20' },
    every: { type: 'string', default: '2' },
    width: { type: 'string', default: '1280' },
    eval: { type: 'string' },
    from: { type: 'string', default: '0' },
    'save-at': { type: 'string' },
    ls: { type: 'string', default: '' },
    port: { type: 'string', default: process.env.PORT ?? '5299' },
    chrome: { type: 'string', default: 'C:/Program Files/Google/Chrome/Application/chrome.exe' },
  },
});
if (!values.out) throw new Error('--out is required');
const port = Number(values.port);
// `--settings` is JSON, or `key=value;key=value` (true, false or a number) where quoting JSON through a shell is a nuisance.
const settings: Record<string, unknown> = values.settings!.startsWith('{')
  ? JSON.parse(values.settings!)
  : Object.fromEntries(values.settings!.split(';').filter(Boolean).map((kv) => {
    const [k, v] = kv.split('=');
    return [k, v === 'true' ? true : v === 'false' ? false : Number.isNaN(Number(v)) ? v : Number(v)];
  }));
mkdirSync(dirname(values.out), { recursive: true });

const children: ChildProcess[] = [];
const profile = mkdtempSync(join(tmpdir(), 'oot-shot-'));
try {
  children.push(spawn('npx', ['vite', '--config', 'vite.config.ts', '--port', String(port), '--strictPort'], { stdio: 'ignore', shell: true }));
  await waitFor('the dev server', async () => ((await fetch(`http://localhost:${port}/`)).ok ? true : undefined), 60_000);
  const debugPort = port + 1;
  children.push(spawn(values.chrome!, [
    '--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--ignore-gpu-blocklist', ...CHROME_SILENT_FLAGS, 'about:blank',
  ], { stdio: 'ignore' }));
  const wsUrl = await waitFor('Chrome', async () => ((await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl);
  const cdp = await Cdp.open(wsUrl);
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
  const call = <T = Record<string, unknown>>(method: string, params: object = {}) => cdp.send<T>(method, params, sessionId);
  const evaluate = async (expression: string) => (await call<{ result: { value?: unknown } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
  await call('Emulation.setDeviceMetricsOverride', { width: Number(values.width), height: 1000, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: `http://localhost:${port}/` });
  await waitFor('the page', async () => ((await evaluate('document.readyState')) === 'complete' ? true : undefined));
  await evaluate(`localStorage.setItem('oot.gfx', JSON.stringify({...JSON.parse(localStorage.getItem('oot.gfx') ?? '{}'), ...${JSON.stringify(settings)}}));`);
  for (const kv of values.ls!.split(';').filter(Boolean)) await evaluate(`localStorage.setItem(${JSON.stringify(kv.split('=')[0])}, ${JSON.stringify(kv.split('=')[1])})`);
  await call('Page.navigate', { url: `http://localhost:${port}/?${values.query.replaceAll(',', '&')}` });
  await waitFor('the first game frame', async () => (JSON.parse((await evaluate('JSON.stringify(globalThis.ootTiming ?? {})')) as string).firstFrame !== undefined ? true : undefined), 120_000);
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'m',code:'KeyM'}))");
  const total = Number(values.seconds), every = Number(values.every);
  for (let t = every; t <= total; t = Math.round((t + every) * 100) / 100) {
    await sleep(every * 1000);
    if (values['save-at'] && t === Number(values['save-at'])) for (const type of ['keyDown', 'keyUp']) await call('Input.dispatchKeyEvent', { type, key: '5', code: 'Digit5', text: type === 'keyDown' ? '5' : undefined });
    if (t < Number(values.from)) continue;
    const rect = (await evaluate("(() => { const r = document.getElementById('screen').getBoundingClientRect(); return JSON.stringify([r.x, r.y, r.width, r.height, document.getElementById('screen').width, document.getElementById('screen').height]); })()")) as string;
    const [x, y, width, height, cw, ch] = JSON.parse(rect) as number[];
    const shot = await call<{ data: string }>('Page.captureScreenshot', { format: 'png', clip: { x, y, width, height, scale: 1 } });
    writeFileSync(`${values.out}-${t}.png`, Buffer.from(shot.data, 'base64'));
    console.log(`${t}s canvas ${cw}x${ch} css ${width}x${height}`);
    if (values.eval) writeFileSync(`${values.out}-${t}.txt`, String(await evaluate(`JSON.stringify(globalThis.${values.eval})`)));
  }
  console.log((await evaluate("document.getElementById('status')?.textContent")) ?? '');
  cdp.close();
} finally {
  for (const c of children) if (c.pid) spawn('taskkill', ['/pid', String(c.pid), '/t', '/f'], { stdio: 'ignore' });
  setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome still holds a file */ } }, 2000).unref();
}
