// Keys 5, 6 and 7 in the real page: headless Chrome against the dev server, with and without the disk saves endpoint, at
// both video rates. Needs the built game and its assets in dist/ (`npm run port`) and Chrome (CHROME_PATH or a usual place).
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer as createViteServer } from 'vite';
import { describe, expect, it } from 'vitest';

const CHROME = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => p && existsSync(p));
const built = existsSync(resolve('dist/oot.wasm')) && existsSync(resolve('dist/assets/manifest.json'));

type Reply = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string } };

/** A minimal Chrome DevTools Protocol client for one page. */
class Page {
  private id = 0;
  private waiting = new Map<number, (m: Reply) => void>();
  readonly console: string[] = [];

  private constructor(private readonly socket: WebSocket) {
    socket.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as Reply;
      if (m.id !== undefined) this.waiting.get(m.id)?.(m);
      else if (m.method === 'Runtime.consoleAPICalled') {
        const args = (m.params?.args ?? []) as { value?: unknown; description?: string }[];
        this.console.push(`${String(m.params?.type)}: ${args.map((a) => String(a.value ?? a.description)).join(' ')}`);
      } else if (m.method === 'Runtime.exceptionThrown') {
        this.console.push(`exception: ${JSON.stringify(m.params?.exceptionDetails)}`);
      }
    };
  }

  static async open(debugPort: number, url: string, beforeLoad: string): Promise<Page> {
    const targets = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const socket = new WebSocket(targets.find((t) => t.type === 'page')!.webSocketDebuggerUrl);
    await new Promise((r) => (socket.onopen = r));
    const page = new Page(socket);
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: beforeLoad });
    await page.send('Page.navigate', { url });
    return page;
  }

  async send(method: string, params: object = {}): Promise<unknown> {
    const id = ++this.id;
    const reply = new Promise<Reply>((r) => this.waiting.set(id, r));
    this.socket.send(JSON.stringify({ id, method, params }));
    const m = await reply;
    if (m.error) throw new Error(`${method}: ${m.error.message}`);
    return m.result;
  }

  async eval<T>(expression: string): Promise<T> {
    const r = (await this.send('Runtime.evaluate', { expression, returnByValue: true })) as { result: { value: T } };
    return r.result.value;
  }

  /** Presses a digit key and returns the notice the page shows for it. */
  async press(key: string): Promise<string> {
    await this.eval(`document.getElementById('notice').hidden = true`);
    for (const type of ['keyDown', 'keyUp']) await this.send('Input.dispatchKeyEvent', { type, key, text: key, code: `Digit${key}`, windowsVirtualKeyCode: key.charCodeAt(0) });
    return waitFor(`a notice after ${key}`, () => this.eval<string>(`(() => { const n = document.getElementById('notice'); return n.hidden ? '' : n.textContent; })()`), 60_000);
  }

  close(): void {
    this.socket.close();
  }
}

async function waitFor<T>(what: string, poll: () => Promise<T | false | '' | undefined>, ms: number): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await poll().catch(() => undefined);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe.skipIf(!CHROME || !built)('save states in the page', () => {
  for (const hz of [50, 60] as const) {
    for (const endpoint of [true, false]) {
      it(`saves, selects and loads slots at ${hz} Hz ${endpoint ? 'with' : 'without'} the saves endpoint`, async () => {
        const saves = mkdtempSync(join(tmpdir(), 'oot-page-saves-'));
        const profile = mkdtempSync(join(tmpdir(), 'oot-page-profile-'));
        process.env.OOT_SAVES_DIR = saves;
        const vite = await createViteServer({ configFile: resolve('vite.config.ts'), server: { port: 0, host: '127.0.0.1' }, logLevel: 'silent' });
        await vite.listen();
        const debugPort = 9300 + Math.floor(Math.random() * 500);
        const chrome: ChildProcess = spawn(CHROME!, ['--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, '--no-first-run', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', 'about:blank'], { stdio: 'ignore' });
        let page: Page | undefined;
        try {
          await waitFor('chrome', () => fetch(`http://127.0.0.1:${debugPort}/json/version`).then((r) => r.ok), 30_000);
          const offline = `const f = window.fetch.bind(window); window.fetch = (u, ...a) => String(u).includes('/api/saves/') ? Promise.reject(new TypeError('offline')) : f(u, ...a);`;
          const url = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}/`;
          page = await Page.open(debugPort, url, `localStorage.setItem('zelda-oot-js:60hz', '${hz === 60 ? 1 : 0}'); ${endpoint ? '' : offline}`);
          const running = () => page!.eval<boolean>(`document.getElementById('status').textContent === 'Running'`);
          await waitFor('the game to run', running, 300_000);
          // Past the boot, where saving is refused.
          await new Promise((r) => setTimeout(r, 15_000));

          expect(await page.press('5')).toBe('Saved slot 1');
          expect(await page.press('6')).toBe('Loaded slot 1');
          expect(await page.press('7')).toBe('Slot 2 (empty)');
          expect(await page.press('6')).toBe('Slot 2 empty');
          expect(await page.press('5')).toBe('Saved slot 2');
          expect(await page.press('6')).toBe('Loaded slot 2');
          // The game goes on running after a load.
          const before = await page.eval<number>(`Number(/frames[^\\d]*(\\d+)/.exec(document.getElementById('overlay').textContent)?.[1] ?? 0)`);
          await new Promise((r) => setTimeout(r, 2000));
          expect(await running()).toBe(true);
          expect(page.console.filter((l) => /^(error|exception)/.test(l)), page.console.join('\n')).toEqual([]);
          void before;
          const files = readdirSync(saves).filter((f) => f.startsWith('state-')).sort();
          expect(files).toEqual(endpoint ? ['state-1.bin', 'state-1.bin.format', 'state-2.bin', 'state-2.bin.format'] : []);
        } finally {
          page?.close();
          chrome.kill();
          await vite.close();
          rmSync(saves, { recursive: true, force: true });
          rmSync(profile, { recursive: true, force: true });
        }
      }, 900_000);
    }
  }
});
