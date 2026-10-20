// `npx tsx tools/gfx/browser-bench.ts [--out out/tex-filter] [--chrome <path>] [--seconds 8] [--screens a,b] [--configs a,b]`: measures the debug overlay's frame rate and
// draw times in headless Chrome for several graphics settings, on a desktop and a phone-sized emulated screen, and writes a
// picture of the 3D canvas for each run. The game is put in the scene of the first save state (key 6, `~/.zelda-oot-js/saves`)
// and runs in the 60 Hz mode. Needs `dist/` from `npm run port`. Pictures come from the ROM, so they stay under `out/`.
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createChromeProfile, removeChromeProfile } from '../lib/chrome-profile.ts';

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: 'out/tex-filter' },
    port: { type: 'string', default: process.env.PORT ?? '5299' },
    chrome: { type: 'string', default: 'C:/Program Files/Google/Chrome/Application/chrome.exe' },
    seconds: { type: 'string', default: '8' },
    screens: { type: 'string', default: '' },
    configs: { type: 'string', default: '' },
  },
});
const port = Number(values.port);
const url = `http://localhost:${port}/?bench#debug`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Screen {
  name: string;
  width: number;
  height: number;
  ratio: number;
  mobile: boolean;
  /** Width of the canvas as the page lays it out. */
  canvasWidth: number;
}

interface Config {
  name: string;
  /** Written to localStorage `oot.gfx` before the page loads. */
  settings: Record<string, unknown>;
}

const SCREENS: Screen[] = [
  { name: 'desktop-1x', width: 1280, height: 800, ratio: 1, mobile: false, canvasWidth: 960 },
  { name: 'desktop-2x', width: 1280, height: 800, ratio: 2, mobile: false, canvasWidth: 960 },
  { name: 'phone-3x', width: 844, height: 390, ratio: 3, mobile: true, canvasWidth: 844 },
];

// The renderer before this option set: whole multiples of 320x240 up to four, no multisampling, no mip levels.
const before = (screen: Screen): Config => {
  const scale = Math.min(4, Math.ceil((screen.canvasWidth * screen.ratio) / 320));
  return { name: 'before', settings: { filter: 'n64', msaa: false, mipmaps: false, anisotropy: 1, scaleCap: (scale * 320) / screen.canvasWidth } };
};
const CONFIGS: Config[] = [
  { name: 'after-default', settings: {} },
  { name: 'after-smooth', settings: { filter: 'smooth' } },
  { name: 'after-sharp', settings: { filter: 'sharp' } },
  { name: 'after-no-msaa', settings: { msaa: false } },
  { name: 'after-no-mips', settings: { mipmaps: false } },
];

class Cdp {
  private next = 1;
  private pending = new Map<number, (r: { result?: unknown; error?: { message: string } }) => void>();
  constructor(private ws: WebSocket) {
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id) this.pending.get(msg.id)?.(msg);
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

interface Sample { build: number; fps: number; game: number; gpu: number; submit: number; displayLists: number; calls: number }

const number = (text: string, pattern: RegExp): number => Number(pattern.exec(text)?.[1] ?? NaN);
const parseOverlay = (text: string): Sample => ({
  build: number(text, /\((\d+) ms to build\)/),
  fps: number(text, /^(\d+) fps/m),
  game: number(text, /game code\s+([\d.]+)/),
  displayLists: number(text, /display lists\s+([\d.]+)/),
  submit: number(text, /submit\s+([\d.]+)/),
  gpu: number(text, /GPU\s+([\d.]+)/),
  calls: number(text, /draw calls\s+([\d.]+)/),
});
const mean = (xs: number[]): number => xs.filter(Number.isFinite).reduce((a, b) => a + b, 0) / Math.max(1, xs.filter(Number.isFinite).length);

async function run(cdp: Cdp, screen: Screen, config: Config, outDir: string, seconds: number): Promise<string> {
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
  const call = <T = Record<string, unknown>>(method: string, params: object = {}) => cdp.send<T>(method, params, sessionId);
  const evaluate = async (expression: string) => (await call<{ result: { value?: unknown } }>('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  try {
    await call('Emulation.setDeviceMetricsOverride', { width: screen.width, height: screen.height, deviceScaleFactor: screen.ratio, mobile: screen.mobile });
    await call('Emulation.setTouchEmulationEnabled', { enabled: screen.mobile, maxTouchPoints: 5 });
    await call('Page.navigate', { url: `http://localhost:${port}/` });
    await waitFor('the page', async () => ((await evaluate('document.readyState')) === 'complete' ? true : undefined));
    await evaluate(`localStorage.setItem('oot.gfx', ${JSON.stringify(JSON.stringify(config.settings))}); localStorage.setItem('zelda-oot-js:60hz', '1')`);
    await call('Page.navigate', { url });
    await waitFor('the first game frame', async () => {
      const marks = (await evaluate('JSON.stringify(globalThis.ootTiming ?? {})')) as string;
      if (JSON.parse(marks).firstFrame !== undefined) return true;
      if ((await evaluate("document.getElementById('status')?.className")) === 'error') throw new Error(String(await evaluate("document.getElementById('status').textContent")));
      return undefined;
    });
    await sleep(500);
    for (const type of ['keyDown', 'keyUp']) await call('Input.dispatchKeyEvent', { type, key: 'm', code: 'KeyM', text: type === 'keyDown' ? 'm' : undefined });
    for (const type of ['keyDown', 'keyUp']) await call('Input.dispatchKeyEvent', { type, key: '6', code: 'Digit6', text: type === 'keyDown' ? '6' : undefined });
    await sleep(4000);
    const samples: Sample[] = [];
    for (let i = 0; i < seconds; i++) {
      await sleep(1000);
      samples.push(parseOverlay(String(await evaluate("document.getElementById('overlay').textContent"))));
    }
    const text = String(await evaluate("document.getElementById('overlay').textContent"));
    const size = /resolution ([\d.]+x \(\d+x\d+\))/.exec(text)?.[1] ?? '?';
    const renderer = await evaluate("(() => { const gl = document.createElement('canvas').getContext('webgl2'); const e = gl?.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : '?'; })()");
    const png = (await evaluate("document.getElementById('screen').toDataURL('image/png')")) as string;
    writeFileSync(join(outDir, `${screen.name}-${config.name}.png`), Buffer.from(png.split(',')[1]!, 'base64'));
    const m = (key: keyof Sample) => mean(samples.map((s) => s[key]));
    return `| ${screen.name} | ${config.name} | ${size} | ${m('fps').toFixed(1)} | ${samples.at(-1)!.build} | ${m('displayLists').toFixed(2)} | ${m('submit').toFixed(2)} | ${m('gpu').toFixed(2)} | ${m('calls').toFixed(0)} | ${String(renderer).slice(0, 50)} |`;
  } finally {
    await cdp.send('Target.closeTarget', { targetId });
  }
}

const children: ChildProcess[] = [];
const profile = createChromeProfile('bench');
let chrome: ChildProcess | undefined;
try {
  const vite = spawn('npx', ['vite', '--config', 'vite.config.ts', '--port', String(port), '--strictPort'], { stdio: 'ignore', shell: true });
  children.push(vite);
  await waitFor('the dev server', async () => ((await fetch(`http://localhost:${port}/`)).ok ? true : undefined));
  const debugPort = port + 1;
  chrome = spawn(values.chrome!, [
    '--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--ignore-gpu-blocklist', '--mute-audio', '--autoplay-policy=no-user-gesture-required', 'about:blank',
  ], { stdio: 'ignore' });
  children.push(chrome);
  const wsUrl = await waitFor('Chrome', async () => ((await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl);
  const cdp = await Cdp.open(wsUrl);
  const outDir = values.out!;
  mkdirSync(outDir, { recursive: true });
  console.log('| screen | settings | 3D image | fps | shader build ms | display lists ms | submit ms | GPU ms | draw calls | GPU |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  const only = (list: string) => (name: string) => list === '' || list.split(',').includes(name);
  for (const screen of SCREENS.filter((x) => only(values.screens!)(x.name))) for (const config of [before(screen), ...CONFIGS].filter((x) => only(values.configs!)(x.name))) console.log(await run(cdp, screen, config, outDir, Number(values.seconds)));
  cdp.close();
} finally {
  for (const c of children) if (c.pid) spawn('taskkill', ['/pid', String(c.pid), '/t', '/f'], { stdio: 'ignore' });
  await removeChromeProfile(profile, chrome);
}
