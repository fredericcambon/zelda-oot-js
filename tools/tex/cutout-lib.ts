// Shared by tools/tex/cutout-compare.ts: starts the dev server and headless Chrome and drives the page over the DevTools protocol.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createChromeProfile, removeChromeProfile } from '../lib/chrome-profile.ts';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
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

export class Cdp {
  private next = 1;
  private pending = new Map<number, (r: { result?: unknown; error?: { message: string } }) => void>();
  private constructor(private ws: WebSocket) {
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

export interface Session {
  cdp: Cdp;
  /** Stops the dev server and Chrome. */
  stop(): Promise<void>;
}

/** Starts `vite` on `port` and Chrome on `port + 1`. */
export async function start(port: number, chrome: string): Promise<Session> {
  const children: ChildProcess[] = [];
  const profile = createChromeProfile('cutout');
  let browser: ChildProcess | undefined;
  const stop = async () => {
    for (const c of children) if (c.pid) spawnSync('taskkill', ['/pid', String(c.pid), '/t', '/f'], { stdio: 'ignore' });
    await removeChromeProfile(profile, browser);
  };
  try {
    children.push(spawn('npx', ['vite', '--config', 'vite.config.ts', '--port', String(port), '--strictPort'], { stdio: 'ignore', shell: true }));
    await waitFor('the dev server', async () => ((await fetch(`http://localhost:${port}/`)).ok ? true : undefined));
    browser = spawn(chrome, [
      '--headless=new', `--remote-debugging-port=${port + 1}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      '--ignore-gpu-blocklist', '--mute-audio', '--autoplay-policy=no-user-gesture-required', 'about:blank',
    ], { stdio: 'ignore' });
    children.push(browser);
    const wsUrl = await waitFor('Chrome', async () => ((await (await fetch(`http://127.0.0.1:${port + 1}/json/version`)).json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl);
    return { cdp: await Cdp.open(wsUrl), stop };
  } catch (err) {
    await stop();
    throw err;
  }
}
