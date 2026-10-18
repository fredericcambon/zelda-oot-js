// `npm run tex -- compare [--out out/tex-compare] [--pack out/texpack]`: opens the page in headless Chrome with the game in Kokiri Forest (save state 1),
// walks Link to six places and, at each, freezes the game on one frame and draws that frame twice, with the original textures and with the pack.
// Writes `view-N-original.png`, `view-N-pack.png`, a 1:1 crop of each where they differ most, and `index.html` side by side. Needs `dist/` and the
// pack. The game runs against a copy of the saves folder, so the saves of the machine are not touched. Pictures come from the cartridge: `out/`.
import { type ChildProcess, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { encodePng } from '../gfx/png.ts';
import type { RgbaImage } from '../gfx/types.ts';
import { savesDir } from '../../web/saves-endpoint.ts';
import { decodePng } from './png-read.ts';

export interface CompareOptions {
  out: string;
  pack: string;
  chrome: string;
  port: number;
  log?: (line: string) => void;
}

/** Keys held, in order, to reach each place from the one before (`code` of the keyboard event, milliseconds held). */
const VIEWS: { name: string; walk: [string, number][] }[] = [
  { name: 'house-front', walk: [] },
  { name: 'path-south', walk: [['ArrowDown', 1500]] },
  { name: 'cliff-west', walk: [['ArrowLeft', 2500]] },
  { name: 'up-the-slope', walk: [['ArrowUp', 3000]] },
  { name: 'east', walk: [['ArrowRight', 3500]] },
  { name: 'far-corner', walk: [['ArrowDown', 3000], ['ArrowLeft', 1500]] },
];

const CROP_W = 480, CROP_H = 360;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  private next = 1;
  private pending = new Map<number, (r: { result?: unknown; error?: { message: string } }) => void>();
  constructor(private ws: WebSocket) {
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id) this.pending.get(msg.id)?.(msg);
    });
  }
  static async open(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
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

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 90_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const v = await probe();
      if (v !== undefined) return v;
    } catch {
      // not up yet
    }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The top-left corner of the CROP_W x CROP_H window where the two pictures differ most (blocks of 16 pixels, summed absolute difference). */
export function mostChangedWindow(a: RgbaImage, b: RgbaImage, w = CROP_W, h = CROP_H): { x: number; y: number; difference: number } {
  const block = 16;
  const bw = Math.floor(a.width / block), bh = Math.floor(a.height / block);
  const sums = new Float64Array(bw * bh);
  for (let y = 0; y < bh * block; y++) {
    for (let x = 0; x < bw * block; x++) {
      const i = (y * a.width + x) * 4;
      sums[Math.floor(y / block) * bw + Math.floor(x / block)]! += Math.abs(a.rgba[i]! - b.rgba[i]!) + Math.abs(a.rgba[i + 1]! - b.rgba[i + 1]!) + Math.abs(a.rgba[i + 2]! - b.rgba[i + 2]!);
    }
  }
  const wb = Math.min(bw, Math.floor(w / block)), hb = Math.min(bh, Math.floor(h / block));
  let best = { x: 0, y: 0, difference: -1 };
  for (let by = 0; by + hb <= bh; by++) {
    for (let bx = 0; bx + wb <= bw; bx++) {
      let sum = 0;
      for (let y = 0; y < hb; y++) for (let x = 0; x < wb; x++) sum += sums[(by + y) * bw + bx + x]!;
      if (sum > best.difference) best = { x: bx * block, y: by * block, difference: sum };
    }
  }
  return best;
}

export function cropImage(img: RgbaImage, x: number, y: number, w: number, h: number): RgbaImage {
  const rgba = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) rgba.set(img.rgba.subarray(((y + row) * img.width + x) * 4, ((y + row) * img.width + x + w) * 4), row * w * 4);
  return { width: w, height: h, rgba };
}

interface Shot {
  name: string;
  original: string;
  pack: string;
  crop: { original: string; pack: string; x: number; y: number };
  summary: { available: boolean; entries: number; seen: number; replaced: number; pending: number };
  /** Drawing the original textures again after the pack gave the picture it gave before. */
  roundTrip: boolean;
  /** Share of pixels where the two pictures differ by more than 8 in some channel. */
  changed: number;
}

export async function compare({ out, pack, chrome, port, log = console.log }: CompareOptions): Promise<void> {
  if (!existsSync(join(pack, 'index.json'))) throw new Error(`no texture pack at ${pack}: run npm run tex -- dump, then npm run tex -- upscale`);
  const saves = mkdtempSync(join(tmpdir(), 'oot-saves-'));
  if (existsSync(savesDir())) cpSync(savesDir(), saves, { recursive: true });
  if (!existsSync(join(saves, 'state-1.bin'))) throw new Error('save state 1 (Kokiri Forest) is missing from the saves folder');
  const profile = mkdtempSync(join(tmpdir(), 'oot-chrome-'));
  const children: ChildProcess[] = [];
  const outDir = resolve(out);
  mkdirSync(outDir, { recursive: true });
  const shots: Shot[] = [];
  try {
    const vite = spawn('npx', ['vite', '--config', 'vite.config.ts', '--port', String(port), '--strictPort'], { stdio: 'ignore', shell: true, env: { ...process.env, OOT_SAVES_DIR: saves, OOT_TEXPACK_DIR: resolve(pack) } });
    children.push(vite);
    await waitFor('the dev server', async () => ((await fetch(`http://localhost:${port}/`)).ok ? true : undefined));
    const debugPort = port + 1;
    children.push(spawn(chrome, [
      '--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      '--ignore-gpu-blocklist', '--mute-audio', '--autoplay-policy=no-user-gesture-required', 'about:blank',
    ], { stdio: 'ignore' }));
    const wsUrl = await waitFor('Chrome', async () => ((await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl);
    const cdp = await Cdp.open(wsUrl);
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const call = <T = Record<string, unknown>>(method: string, params: object = {}) => cdp.send<T>(method, params, sessionId);
    const evaluate = async (expression: string) => {
      const r = await call<{ result: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text: string } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(`${expression}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value;
    };
    const key = (type: 'keyDown' | 'keyUp', code: string, k = code) => call('Input.dispatchKeyEvent', { type, key: k, code, text: type === 'keyDown' && k.length === 1 ? k : undefined });
    const tap = async (code: string, k = code) => { await key('keyDown', code, k); await key('keyUp', code, k); };

    await call('Page.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
    // The game's frame loop can be held on a frame: while `held` is set the page's next animation frame request is kept, not run.
    await call('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => { const raf = window.requestAnimationFrame.bind(window); let held = false, kept = null;
        window.requestAnimationFrame = (cb) => (held ? ((kept = cb), 0) : raf(cb));
        window.ootHold = (on) => { held = on; if (!on && kept) { const cb = kept; kept = null; raf(cb); } }; })()`,
    });
    await call('Page.navigate', { url: `http://localhost:${port}/` });
    await waitFor('the page', async () => ((await evaluate('document.readyState')) === 'complete' ? true : undefined));
    await evaluate("localStorage.setItem('zelda-oot-js:60hz', '1'); localStorage.setItem('oot.texpack', '1'); localStorage.removeItem('oot.gfx'); localStorage.removeItem('oot.smooth')");
    await call('Page.navigate', { url: `http://localhost:${port}/#debug` });
    await call('Page.reload');
    await waitFor('the first game frame', async () => {
      const marks = (await evaluate('JSON.stringify(globalThis.ootTiming ?? {})')) as string;
      if (JSON.parse(marks).firstFrame !== undefined) return true;
      if ((await evaluate("document.getElementById('status')?.className")) === 'error') throw new Error(String(await evaluate("document.getElementById('status').textContent")));
      return undefined;
    });
    await waitFor('the texture pack', async () => ((await evaluate('globalThis.ootTexPack?.pack.available === true')) ? true : undefined));
    log(`pack: ${JSON.stringify(await evaluate('globalThis.ootTexPack.pack.summary()'))}`);
    await tap('KeyM', 'm');
    await tap('Digit6', '6');
    await sleep(4000);

    const screenshot = async (): Promise<RgbaImage> => {
      const url = (await evaluate("document.getElementById('screen').toDataURL('image/png')")) as string;
      return decodePng(Buffer.from(url.split(',')[1]!, 'base64'));
    };
    for (const [n, view] of VIEWS.slice(0, Number(process.env.TEX_VIEWS ?? VIEWS.length)).entries()) {
      for (const [code, ms] of view.walk) {
        await key('keyDown', code);
        await sleep(ms);
        await key('keyUp', code);
      }
      await sleep(1500);
      // Let the replacements the walk asked for arrive while the game runs, then hold the frame.
      await waitFor('the replacements', async () => (((await evaluate('globalThis.ootTexPack.pack.summary().pending')) as number) === 0 ? true : undefined));
      await evaluate('window.ootHold(true)');
      await sleep(400);
      const draw = async (enabled: boolean): Promise<RgbaImage> => {
        await evaluate(`globalThis.ootTexPack.pack.enabled = ${enabled}`);
        // Switching clears the textures; the replacements are fetched when the frame is drawn, and the frame is drawn again once they are in.
        await evaluate('globalThis.ootTexPack.redraw()');
        await waitFor('the replacements', async () => (((await evaluate('globalThis.ootTexPack.pack.summary().pending')) as number) === 0 ? true : undefined));
        await evaluate('globalThis.ootTexPack.redraw()');
        return screenshot();
      };
      const before = await draw(false);
      const packed = await draw(true);
      const summary = (await evaluate('globalThis.ootTexPack.pack.summary()')) as Shot['summary'];
      log(`replacements in use by the last draw: ${await evaluate('globalThis.ootTexPack.inUse()')}`);
      const again = await draw(false);
      await evaluate('globalThis.ootTexPack.pack.enabled = true; window.ootHold(false)');
      const id = `view-${n + 1}-${view.name}`;
      const window_ = mostChangedWindow(before, packed);
      const files = {
        original: `${id}-original.png`, pack: `${id}-pack.png`,
        crop: { original: `${id}-crop-original.png`, pack: `${id}-crop-pack.png`, x: window_.x, y: window_.y },
      };
      writeFileSync(join(outDir, files.original), encodePng(before.width, before.height, before.rgba));
      writeFileSync(join(outDir, files.pack), encodePng(packed.width, packed.height, packed.rgba));
      for (const [img, file] of [[before, files.crop.original], [packed, files.crop.pack]] as const) {
        const c = cropImage(img, window_.x, window_.y, Math.min(CROP_W, img.width), Math.min(CROP_H, img.height));
        writeFileSync(join(outDir, file), encodePng(c.width, c.height, c.rgba));
      }
      const roundTrip = Buffer.compare(Buffer.from(before.rgba), Buffer.from(again.rgba)) === 0;
      let differing = 0;
      for (let i = 0; i < before.rgba.length; i += 4) {
        if (Math.max(Math.abs(before.rgba[i]! - packed.rgba[i]!), Math.abs(before.rgba[i + 1]! - packed.rgba[i + 1]!), Math.abs(before.rgba[i + 2]! - packed.rgba[i + 2]!)) > 8) differing++;
      }
      const changed = differing / (before.rgba.length / 4);
      shots.push({ name: view.name, ...files, summary, roundTrip, changed });
      log(`${id}: ${(changed * 100).toFixed(1)}% of pixels differ by more than 8; ${before.width}x${before.height}, replaced ${summary.replaced} of ${summary.seen} textures seen so far, original again identical: ${roundTrip}`);
    }
    cdp.close();
    const index = JSON.parse(readFileSync(join(pack, 'index.json'), 'utf8')) as { model: string; settings: { blend: number; pad: number }; release: string };
    writeFileSync(join(outDir, 'index.html'), page(shots, index));
    log(`written to ${outDir}${'/'}index.html`);
  } finally {
    for (const c of children) if (c.pid) spawn('taskkill', ['/pid', String(c.pid), '/t', '/f'], { stdio: 'ignore' });
    setTimeout(() => {
      for (const dir of [profile, saves]) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // Chrome still holds a file.
        }
      }
    }, 3000).unref();
  }
}

function page(shots: Shot[], index: { model: string; settings: { blend: number; pad: number }; release: string }): string {
  const rows = shots.map((s) => `
<section>
  <h2>${s.name}</h2>
  <p>pack: ${s.summary.replaced} of ${s.summary.seen} distinct textures seen so far replaced. ${(s.changed * 100).toFixed(1)}% of the pixels differ by more than 8/255. Original drawn again after the pack: ${s.roundTrip ? 'identical' : 'DIFFERENT'}.</p>
  <div class="swipe" data-pos="50"><img src="${s.pack}"><img class="top" src="${s.original}"><div class="bar"></div><span class="l">original</span><span class="r">pack (x2)</span></div>
  <div class="pair"><figure><figcaption>original</figcaption><img src="${s.original}"></figure><figure><figcaption>pack (x2)</figcaption><img src="${s.pack}"></figure></div>
  <p>The most changed area at 1:1 (from ${s.crop.x}, ${s.crop.y}):</p>
  <div class="pair"><figure><figcaption>original</figcaption><img class="crop" src="${s.crop.original}"></figure><figure><figcaption>pack (x2)</figcaption><img class="crop" src="${s.crop.pack}"></figure></div>
</section>`).join('\n');
  return `<!doctype html>
<meta charset="utf-8">
<title>Kokiri Forest: original textures against the x2 pack</title>
<style>
  body { background: #181818; color: #ddd; font: 15px sans-serif; margin: 1.5em; }
  .pair { display: flex; gap: 1em; align-items: flex-start; }
  figure { margin: 0; flex: 1 1 0; min-width: 0; }
  img { width: 100%; display: block; }
  img.crop { width: auto; max-width: 100%; image-rendering: pixelated; }
  figcaption { padding: .2em 0; color: #9c9; }
  section { margin-bottom: 3em; }
  .swipe { position: relative; touch-action: none; cursor: ew-resize; user-select: none; margin-bottom: 1em; }
  .swipe img { width: 100%; display: block; }
  .swipe img.top { position: absolute; inset: 0; clip-path: inset(0 50% 0 0); }
  .swipe .bar { position: absolute; top: 0; bottom: 0; left: 50%; width: 3px; margin-left: -1px; background: #fff; box-shadow: 0 0 4px #000; }
  .swipe span { position: absolute; top: .4em; padding: .1em .5em; background: #000a; color: #fff; }
  .swipe .l { left: .4em; } .swipe .r { right: .4em; }
</style>
<h1>Kokiri Forest: original textures against the x2 pack</h1>
<p>Model ${index.model} (${index.release}), colour mixed ${Math.round(index.settings.blend * 100)}% model with ${Math.round((1 - index.settings.blend) * 100)}% plain bilinear x2, padding ${index.settings.pad}. Each pair is the same game frame, drawn twice by the page's renderer with its default filter settings. Click a picture to open it at full size.</p>
${rows}
<script>
for (const i of document.querySelectorAll('.pair img')) i.onclick = () => open(i.src);
for (const box of document.querySelectorAll('.swipe')) {
  const set = (x) => {
    const r = box.getBoundingClientRect(), f = Math.min(1, Math.max(0, (x - r.left) / r.width)) * 100;
    box.querySelector('.top').style.clipPath = 'inset(0 ' + (100 - f) + '% 0 0)';
    box.querySelector('.bar').style.left = f + '%';
  };
  box.addEventListener('pointerdown', (e) => { box.setPointerCapture(e.pointerId); set(e.clientX); });
  box.addEventListener('pointermove', (e) => { if (box.hasPointerCapture(e.pointerId)) set(e.clientX); });
}
</script>
`;
}
