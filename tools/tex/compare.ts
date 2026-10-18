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
import type { TextureRecord } from './collect.ts';
import { analyzeMoving, type TextureFacts } from './moving.ts';
import { VARIANTS, type PackStats } from './upscale.ts';

export interface CompareOptions {
  out: string;
  pack: string;
  /** The dump the pack was made from (`out/texdump`): the textures it knows tell the moving capture which misses are new. */
  dump?: string;
  /** Variants of the pack to capture (default: all that exist). */
  variants?: string[];
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

interface Crop {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Shot {
  name: string;
  crops: Crop[];
  /** Per variant: share of pixels where its picture differs from the original's by more than 8 in some channel, and how many textures it replaced. */
  changed: Record<string, number>;
  replaced: Record<string, { replaced: number; seen: number }>;
  /** Drawing the original textures again after the packs gave the picture it gave before. */
  roundTrip: boolean;
}

interface VariantInfo {
  name: string;
  label: string;
  stats: PackStats;
  seams: { wrapping: number; worse: number };
}

export async function compare({ out, pack, dump = 'out/texdump', variants: wanted, chrome, port, log = console.log }: CompareOptions): Promise<void> {
  const variants = VARIANTS.filter((v) => (!wanted || wanted.includes(v.name)) && existsSync(join(pack, v.name, 'index.json'))).map((v) => v.name);
  if (variants.length === 0) throw new Error(`no texture pack at ${pack}: run npm run tex -- dump, then npm run tex -- upscale`);
  const info: VariantInfo[] = variants.map((name) => ({ name, ...(JSON.parse(readFileSync(join(pack, name, 'index.json'), 'utf8')) as Omit<VariantInfo, 'name'>) }));
  const saves = mkdtempSync(join(tmpdir(), 'oot-saves-'));
  if (existsSync(savesDir())) cpSync(savesDir(), saves, { recursive: true });
  if (!existsSync(join(saves, 'state-1.bin'))) throw new Error('save state 1 (Kokiri Forest) is missing from the saves folder');
  const profile = mkdtempSync(join(tmpdir(), 'oot-chrome-'));
  const children: ChildProcess[] = [];
  const outDir = resolve(out);
  mkdirSync(outDir, { recursive: true });
  const shots: Shot[] = [];
  const facts = Object.values((JSON.parse(readFileSync(join(dump, 'index.json'), 'utf8')) as { textures: Record<string, TextureRecord> }).textures);
  // Close-ups are centred on the on-screen area drawn with a texture of the kind, in the views (1-based) that show it. Bush: the plants' leaf texture
  // (a 32x32 cut-out that clamps). Wall: the forest's cliff face (two textures). Both picked by looking at where each texture is drawn.
  const closeUps: Record<string, { hashes: string[]; views: number[] }> = {
    bush: { hashes: ['748beec470b5bc6a'], views: [3, 4, 6] },
    wall: { hashes: ['909f9c2dbe2cf50b', 'bdaf804b5358c497'], views: [1, 2, 4] },
  };
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
    await evaluate(`globalThis.ootTexPack.pack.setVariant('${variants[0]}')`);
    await waitFor('the texture pack', async () => ((await evaluate('globalThis.ootTexPack?.pack.available === true')) ? true : undefined));
    await tap('KeyM', 'm');
    await tap('Digit6', '6');
    await sleep(4000);

    // Moving capture: the same walk with the first variant, every texture each graphics task draws recorded (web/renderer.ts). The walk runs twice: the
    // first pass asks for the replacements, the second is recorded, so that a texture that was never replaced is not a texture still on its way.
    const known = new Map(facts.map((t) => [t.hash, t]));
    const walk = async (): Promise<void> => {
      for (const code of ['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp']) {
        await key('keyDown', code);
        await sleep(4000);
        await key('keyUp', code);
      }
    };
    await walk();
    await evaluate('globalThis.ootTexPack.record(true)');
    await walk();
    const recorded = (await evaluate('globalThis.ootTexPack.recorded()')) as { frames: string[][]; facts: Record<string, TextureFacts> };
    await evaluate('globalThis.ootTexPack.record(false)');
    const moving = analyzeMoving(recorded.frames, recorded.facts, known);
    writeFileSync(join(outDir, 'moving.json'), JSON.stringify(moving, null, 1));
    rmSync(join(outDir, 'unresolved'), { recursive: true, force: true });
    mkdirSync(join(outDir, 'unresolved'), { recursive: true });
    for (const u of moving.unresolved) {
      const f = recorded.facts[u.hash];
      if (f?.rgba) writeFileSync(join(outDir, 'unresolved', `${u.hash}.png`), encodePng(f.width, f.height, Buffer.from(f.rgba, 'base64')));
    }
    log(`moving: ${moving.tasks} graphics tasks, ${moving.textures} textures drawn, ${moving.inPack} with an entry in the pack, ${moving.flickering.length} that went from replaced back to original, ${moving.unresolved.length} without an entry`);
    for (const u of moving.unresolved) log(`  ${u.hash} (${u.tasks} tasks): ${u.reason}`);
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
      const draw = async (variant: string | null): Promise<RgbaImage> => {
        if (variant) await evaluate(`globalThis.ootTexPack.pack.setVariant('${variant}')`);
        await evaluate(`globalThis.ootTexPack.pack.enabled = ${variant !== null}`);
        // Switching clears the textures; the replacements are fetched when the frame is drawn, and the frame is drawn again once they are in.
        await evaluate('globalThis.ootTexPack.redraw()');
        await waitFor('the replacements', async () => (((await evaluate('globalThis.ootTexPack.pack.summary().pending')) as number) === 0 ? true : undefined));
        await evaluate('globalThis.ootTexPack.redraw()');
        return screenshot();
      };
      const id = `view-${n + 1}-${view.name}`;
      const original = await draw(null);
      const save = (img: RgbaImage, file: string): void => writeFileSync(join(outDir, file), encodePng(img.width, img.height, img.rgba));
      save(original, `${id}-original.png`);
      const crops: Crop[] = [];
      for (const [name, { hashes, views }] of Object.entries(closeUps)) {
        if (!views.includes(n + 1)) continue;
        const box = (await evaluate(`globalThis.ootTexPack.boundsOf(${JSON.stringify(hashes)})`)) as { x: number; y: number; w: number; h: number } | null;
        if (!box) continue;
        const w = Math.min(CROP_W, original.width), h = Math.min(CROP_H, original.height);
        crops.push({ name, w, h, x: Math.round(Math.min(original.width - w, Math.max(0, box.x + box.w / 2 - w / 2))), y: Math.round(Math.min(original.height - h, Math.max(0, box.y + box.h / 2 - h / 2))) });
      }
      for (const c of crops) save(cropImage(original, c.x, c.y, c.w, c.h), `${id}-${c.name}-original.png`);
      const changed: Shot['changed'] = {};
      const replaced: Shot['replaced'] = {};
      for (const v of variants) {
        const picture = await draw(v);
        const summary = (await evaluate('globalThis.ootTexPack.pack.summary()')) as { replaced: number; seen: number };
        save(picture, `${id}-${v}.png`);
        for (const c of crops) save(cropImage(picture, c.x, c.y, c.w, c.h), `${id}-${c.name}-${v}.png`);
        let differing = 0;
        for (let i = 0; i < original.rgba.length; i += 4) {
          if (Math.max(Math.abs(original.rgba[i]! - picture.rgba[i]!), Math.abs(original.rgba[i + 1]! - picture.rgba[i + 1]!), Math.abs(original.rgba[i + 2]! - picture.rgba[i + 2]!)) > 8) differing++;
        }
        changed[v] = differing / (original.rgba.length / 4);
        replaced[v] = summary;
        log(`${id} ${v}: ${(changed[v]! * 100).toFixed(1)}% of pixels differ by more than 8; replaced ${summary.replaced} of ${summary.seen} textures seen so far`);
      }
      const again = await draw(null);
      await evaluate('globalThis.ootTexPack.pack.enabled = true; window.ootHold(false)');
      const roundTrip = Buffer.compare(Buffer.from(original.rgba), Buffer.from(again.rgba)) === 0;
      shots.push({ name: view.name, crops, changed, replaced, roundTrip });
      log(`${id}: original again identical: ${roundTrip}`);
    }
    cdp.close();
    writeFileSync(join(outDir, 'index.html'), page(shots, info));
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

function page(shots: Shot[], info: VariantInfo[]): string {
  const mib = (n: number): string => (n / 1048576).toFixed(1);
  const rows = info.map((v) => `<tr><td>${v.name}</td><td>${v.label}</td><td>${v.stats.textures}</td><td>${mib(v.stats.bytes)}</td><td>${mib((v.stats.bytes * 4) / 3)}</td><td>${(v.stats.bytes / v.stats.originalBytes).toFixed(1)}x</td><td>${v.stats.modelSeconds}</td><td>${v.stats.otherSeconds}</td><td>${(v.stats.modelSeconds + v.stats.otherSeconds).toFixed(1)}</td><td>${v.seams.worse} of ${v.seams.wrapping}</td></tr>`).join('\n');
  const options = ['original', ...info.map((v) => v.name)].map((n) => `<option value="${n}">${n === 'original' ? 'original' : `${n}: ${info.find((v) => v.name === n)!.label}`}</option>`).join('');
  const swipe = (base: string, crop = false): string => `<div class="swipe${crop ? ' crop' : ''}" data-base="${base}"><img class="under"><img class="top"><div class="bar"></div><span class="l"></span><span class="r"></span></div>`;
  const sections = shots.map((s) => `
<section>
  <h2>${s.name}</h2>
  <p>${info.map((v) => `${v.name}: ${(s.changed[v.name]! * 100).toFixed(1)}% of pixels differ by more than 8/255, ${s.replaced[v.name]!.replaced} of ${s.replaced[v.name]!.seen} distinct textures seen so far replaced`).join('; ')}. Original drawn again after the packs: ${s.roundTrip ? 'identical' : 'DIFFERENT'}.</p>
  ${swipe(`view-${shots.indexOf(s) + 1}-${s.name}`)}
  ${s.crops.map((c) => `<h3>${c.name} close-up (${c.w}x${c.h} at 1:1 of the ${s.name} picture)</h3>${swipe(`view-${shots.indexOf(s) + 1}-${s.name}-${c.name}`, true)}`).join('\n')}
</section>`).join('\n');
  return `<!doctype html>
<meta charset="utf-8">
<title>Kokiri Forest: original textures against four pack variants</title>
<style>
  body { background: #181818; color: #ddd; font: 15px sans-serif; margin: 1.5em; }
  h3 { color: #9c9; font-weight: normal; }
  section { margin-bottom: 3em; }
  table { border-collapse: collapse; } td, th { border: 1px solid #444; padding: .2em .6em; text-align: right; } td:nth-child(2) { text-align: left; }
  .bar2 { position: sticky; top: 0; background: #181818ee; padding: .5em 0; z-index: 5; }
  select { font-size: 15px; }
  .swipe { position: relative; touch-action: none; cursor: ew-resize; user-select: none; margin-bottom: 1em; max-width: 1920px; }
  .swipe img { width: 100%; display: block; image-rendering: auto; }
  .swipe.crop img { image-rendering: pixelated; }
  .swipe img.top { position: absolute; inset: 0; clip-path: inset(0 50% 0 0); }
  .swipe .bar { position: absolute; top: 0; bottom: 0; left: 50%; width: 3px; margin-left: -1px; background: #fff; box-shadow: 0 0 4px #000; }
  .swipe span { position: absolute; top: .4em; padding: .1em .5em; background: #000a; color: #fff; }
  .swipe .l { left: .4em; } .swipe .r { right: .4em; }
</style>
<h1>Kokiri Forest: original textures against four pack variants</h1>
<p>Each picture is one game frame drawn by the page's renderer (default filter settings) once per texture set. Drag the divider: the left side shows the first selection, the right side the second. Alpha of every variant is a plain bicubic enlargement of the original's, never touched by the model. Close-ups are 1:1 crops of the same frames, zoomed by your browser with hard pixels.</p>
<table>
<tr><th>variant</th><th>what</th><th>textures</th><th>MiB RGBA8</th><th>MiB with mips</th><th>vs originals</th><th>model s</th><th>other s</th><th>total s</th><th>wrap seams worse than bilinear</th></tr>
${rows}
</table>
<p>Memory is for the ${info[0]!.stats.textures} replaced textures only (originals: ${mib(info[0]!.stats.originalBytes)} MiB RGBA8). Model time is shared by variants of the same factor (a and b share the x2 run, c and d the x4 run); other = padding, blending, alpha, seam check and PNG writing.</p>
<div class="bar2">left: <select id="left">${options}</select> right: <select id="right">${options.replace('<option value="a">', '<option value="a" selected>')}</select></div>
${sections}
<script>
const boxes = [...document.querySelectorAll('.swipe')];
const left = document.getElementById('left'), right = document.getElementById('right');
const show = () => { for (const box of boxes) {
  const [a, b] = [left.value, right.value];
  box.querySelector('.top').src = box.dataset.base + '-' + a + '.png';
  box.querySelector('.under').src = box.dataset.base + '-' + b + '.png';
  box.querySelector('.l').textContent = a; box.querySelector('.r').textContent = b;
} };
left.onchange = right.onchange = show; show();
for (const box of boxes) {
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
