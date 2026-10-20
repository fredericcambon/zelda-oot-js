// Drives the overlay in headless Chrome with emulated touch events. Skipped when no Chrome is found (set CHROME_PATH to point at one).
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';
import { afterAll, describe, expect, it } from 'vitest';
import { createChromeProfile, removeChromeProfile } from '../tools/lib/chrome-profile.ts';
import { CHROME_SILENT_FLAGS } from '../tools/port/cdp.ts';
import { Button, STICK_MAX } from './input.ts';

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const chrome = CANDIDATES.find((p) => p && existsSync(p));

let proc: ChildProcess | undefined;
let dir: string | undefined;
let profile: string | undefined;
afterAll(async () => {
  if (profile) await removeChromeProfile(profile, proc);
  if (dir) rmSync(dir, { recursive: true, force: true });
});

interface Reply { result: { result: { value: string } } }

describe.skipIf(!chrome)('touch overlay in headless Chrome', () => {
  it('sets the A bit and the stick axis from touch events, at the same time', async () => {
    dir = mkdtempSync(join(tmpdir(), 'oot-touch-'));
    const js = buildSync({
      stdin: { contents: "import { TouchControls } from './web/touch.ts'; window.touch = new TouchControls(document.getElementById('layer'), document.getElementById('toggle'));", resolveDir: process.cwd(), sourcefile: 'entry.ts' },
      bundle: true, write: false, format: 'iife',
    }).outputFiles?.[0]?.text ?? '';
    const html = `<!doctype html><meta name="viewport" content="width=device-width"><style>#layer{position:fixed;inset:0}#layer *{touch-action:none}#touch-stick{position:absolute;left:0;bottom:0;width:40%;height:60%}#touch-buttons{position:absolute;right:8px;bottom:8px}.touch-button{position:absolute}</style><div id="layer"></div><button id="toggle"></button><script>${js}</script>`;
    profile = createChromeProfile('touch');
    const file = join(dir, 'page.html');
    writeFileSync(file, html);

    const port = 9300 + Math.floor(Math.random() * 500);
    proc = spawn(chrome as string, ['--headless=new', ...CHROME_SILENT_FLAGS, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=844,390', 'about:blank'], { stdio: 'ignore' });
    let targets: Array<{ type: string; webSocketDebuggerUrl: string }> = [];
    for (let i = 0; i < 100 && !targets.length; i++) {
      await new Promise((r) => setTimeout(r, 100));
      targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).catch(() => []);
    }
    const ws = new WebSocket(targets.find((t) => t.type === 'page')!.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    let id = 0;
    const pending = new Map<number, (v: Reply) => void>();
    ws.addEventListener('message', (m) => {
      const msg = JSON.parse(String(m.data));
      pending.get(msg.id)?.(msg);
    });
    const send = (method: string, params: object = {}) => new Promise<Reply>((res) => { pending.set(++id, res); ws.send(JSON.stringify({ id, method, params })); });
    const evalJs = async (expression: string) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.result.value;
    const touch = (type: string, points: Array<{ x: number; y: number; id: number }>) =>
      send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id })) });

    await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await send('Page.navigate', { url: pathToFileURL(file).href });
    await new Promise((r) => setTimeout(r, 800));

    const centre = async (sel: string) => JSON.parse(await evalJs(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`));
    const pad = async () => await evalJs('JSON.stringify(window.touch.poll())').then(JSON.parse);

    expect(await pad()).toEqual({ buttons: 0, x: 0, y: 0 });
    const a = await centre('#touch-a');
    await touch('touchStart', [{ ...a, id: 1 }]);
    expect((await pad()).buttons & Button.A).toBe(Button.A);

    await touch('touchEnd', []);
    expect((await pad()).buttons).toBe(0);
    await touch('touchStart', [{ ...a, id: 3 }]);
    await touch('touchStart', [{ ...a, id: 3 }, { x: 100, y: 250, id: 4 }]);
    await touch('touchMove', [{ ...a, id: 3 }, { x: 100 + 200, y: 250, id: 4 }]);
    const both = await pad();
    expect(both.buttons & Button.A).toBe(Button.A);
    expect(both.x).toBe(STICK_MAX);

    await touch('touchEnd', []);
    expect(await pad()).toEqual({ buttons: 0, x: 0, y: 0 });
    ws.close();
  }, 60_000);
});
