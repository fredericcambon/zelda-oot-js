// A minimal Chrome DevTools Protocol client over the browser's WebSocket, shared by the page-driving scripts of this folder.
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
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

export class Cdp {
  private next = 1;
  private pending = new Map<number, (r: { result?: unknown; error?: { message: string } }) => void>();
  private listeners: ((method: string, params: Record<string, unknown>, session?: string) => void)[] = [];
  constructor(private ws: WebSocket) {
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id) this.pending.get(msg.id)?.(msg);
      else for (const l of this.listeners) l(msg.method, msg.params, msg.sessionId);
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
  on(l: (method: string, params: Record<string, unknown>, session?: string) => void): void {
    this.listeners.push(l);
  }
  close(): void {
    this.ws.close();
  }
}
