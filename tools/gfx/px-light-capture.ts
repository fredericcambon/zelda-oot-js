// `OOT_SAVES_DIR=out/px-light/saves npx tsx tools/gfx/px-light-capture.ts [--out out/px-light]`: loads the save states made by px-light-states.ts in headless Chrome
// in the vertex and in the pixel lighting mode (the other effects off), writes a picture of the 3D canvas for each and prints the frame
// times from the debug overlay and the lighting counts. Needs `dist/` from `npm run port`. Pictures come from the ROM, so they stay under `out/`.
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: 'out/px-light' },
    port: { type: 'string', default: process.env.PORT ?? '5299' },
    chrome: { type: 'string', default: 'C:/Program Files/Google/Chrome/Application/chrome.exe' },
    seconds: { type: 'string', default: '8' },
  },
});
const port = Number(values.port);
const url = `http://localhost:${port}/?bench#debug`;
const SCENES = [{ name: 'forest', slot: 1 }, { name: 'house', slot: 2 }];
const MODES = ['vertex', 'pixel'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  private next = 1;
  private pending = new Map<number, (r: { result?: unknown; error?: { message: string } }) => void>();
  constructor(private ws: WebSocket) {
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id) this.pending.get(msg.id)?.(msg);
      else if (process.env.PAGE_LOG && /^(Runtime|Log)./.test(msg.method)) console.error(JSON.stringify(msg.params).slice(0, 500));
    });
  }
  static async open(wsUrl: string): Promise<Cdp> {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    return new Cdp(ws);
  }
  send<T = Record<string, unknown>>(method: string, params: object = {}, session?: string): Promise<T> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (r) => (r.error ? reject(new Error(`${method}: ${r.error.message}`)) : resolve(r.result as T)));
      this.ws.send(JSON.stringify({ id, method, params, sessionId: session }));
    });
  }
  close(): void {
    this.ws.close();
  }
}

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const v = await probe();
      if (v !== undefined) return v;
    } catch {
      // not up yet
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const mean = (xs: number[]): number => xs.filter(Number.isFinite).reduce((a, b) => a + b, 0) / Math.max(1, xs.filter(Number.isFinite).length);
const number = (text: string, pattern: RegExp): number => Number(pattern.exec(text)?.[1] ?? NaN);
const press = async (call: (m: string, p?: object) => Promise<unknown>, key: string, code: string) => {
  for (const type of ['keyDown', 'keyUp']) await call('Input.dispatchKeyEvent', { type, key, code, text: type === 'keyDown' ? key : undefined });
};

async function run(cdp: Cdp, scene: { name: string; slot: number }, mode: string, outDir: string, seconds: number): Promise<string> {
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
  const call = <T = Record<string, unknown>>(method: string, params: object = {}) => cdp.send<T>(method, params, sessionId);
  const evaluate = async (expression: string) => (await call<{ result: { value?: unknown } }>('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  try {
    await call('Runtime.enable');
    await call('Log.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `http://localhost:${port}/` });
    await waitFor('the page', async () => ((await evaluate('document.readyState')) === 'complete' ? true : undefined));
    const settings = { lightingMode: mode, ao: false, bloom: false, sharpen: false };
    await evaluate(`localStorage.setItem('oot.gfx', ${JSON.stringify(JSON.stringify(settings))}); localStorage.setItem('zelda-oot-js:60hz', '0')`);
    await call('Page.navigate', { url });
    await waitFor('the first game frame', async () => {
      if (process.env.DEBUG_PAGE_OFF) console.error(await evaluate('document.body.innerText.slice(0, 300) + JSON.stringify(globalThis.ootTiming ?? {})'));
      const marks = (await evaluate('JSON.stringify(globalThis.ootTiming ?? {})')) as string;
      if (JSON.parse(marks).firstFrame !== undefined) return true;
      if ((await evaluate("document.getElementById('status')?.className")) === 'error') throw new Error(String(await evaluate("document.getElementById('status').textContent")));
      return undefined;
    }, 120_000);
    await sleep(500);
    await press(call, 'm', 'KeyM');
    for (let i = 1; i < scene.slot; i++) await press(call, '7', 'Digit7');
    await press(call, '6', 'Digit6');
    await sleep(4000);
    const rows: number[][] = [];
    for (let i = 0; i < seconds; i++) {
      await sleep(1000);
      const t = String(await evaluate("document.getElementById('overlay').textContent"));
      rows.push([/game code\s+([\d.]+)/, /display lists\s+([\d.]+)/, /submit\s+([\d.]+)/, /GPU\s+([\d.]+)/, /total \(CPU\)\s+([\d.]+)/, /draw calls\s+([\d.]+)/].map((re) => number(t, re)));
    }
    const stats = (await evaluate('JSON.stringify(globalThis.ootRenderer?.stats?.lighting)')) as string;
    const png = (await evaluate("document.getElementById('screen').toDataURL('image/png')")) as string;
    writeFileSync(join(outDir, `${scene.name}-${mode}.png`), Buffer.from(png.split(',')[1]!, 'base64'));
    const m = (i: number) => mean(rows.map((r) => r[i]!)).toFixed(2);
    return `| ${scene.name} | ${mode} | ${m(0)} | ${m(1)} | ${m(2)} | ${m(3)} | ${m(4)} | ${m(5)} | ${stats} |`;
  } finally {
    await cdp.send('Target.closeTarget', { targetId });
  }
}

const children: ChildProcess[] = [];
const profile = mkdtempSync(join(tmpdir(), 'oot-chrome-'));
try {
  const vite = spawn('npx', ['vite', '--config', 'vite.config.ts', '--port', String(port), '--strictPort'], { stdio: 'ignore', shell: true });
  children.push(vite);
  await waitFor('the dev server', async () => ((await fetch(`http://localhost:${port}/`)).ok ? true : undefined));
  const debugPort = port + 1;
  const chrome = spawn(values.chrome!, [
    '--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--ignore-gpu-blocklist', '--mute-audio', '--autoplay-policy=no-user-gesture-required', 'about:blank',
  ], { stdio: 'ignore' });
  children.push(chrome);
  const wsUrl = await waitFor('Chrome', async () => ((await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl);
  const cdp = await Cdp.open(wsUrl);
  const outDir = values.out!;
  mkdirSync(outDir, { recursive: true });
  console.log('| scene | lighting | game code ms | display lists ms | submit ms | GPU ms | CPU ms | draw calls | lighting counts |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const scene of SCENES) for (const mode of MODES) console.log(await run(cdp, scene, mode, outDir, Number(values.seconds)));
  cdp.close();
} finally {
  for (const c of children) if (c.pid) spawn('taskkill', ['/pid', String(c.pid), '/t', '/f'], { stdio: 'ignore' });
  setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome still holds a file */ } }, 2000).unref();
}
