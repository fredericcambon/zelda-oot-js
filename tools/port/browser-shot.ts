// `npx tsx tools/port/browser-shot.ts --query "file=1,warp=0x422" --out out/shots/name [flags]`:
// runs the dev server and headless Chrome (muted), opens the page with the query, and saves a picture of the canvas every few seconds
// (`<out>-<seconds>.png`). One short line per shot (path and size), no other logs. Flags:
//   --query <a=b,c=d>      page query (commas become &)           --settings <json|k=v;k=v>  merged over the graphics settings (localStorage `oot.gfx`)
//   --ls k=v;k=v           other localStorage keys (`oot.smooth=0`)  --width <px>  browser width, default 1280
//   --seconds <n> --every <s> --from <s>   shot every s seconds up to n, skipping those before `from`
//   --frames <n> --every-frames <k>        instead of seconds: n shots, each after k more game frames (adds `capture` to the query; names `<out>-f<frame>.png`)
//   --save-at <seconds>    presses 5 (save state to the current slot; set OOT_SAVES_DIR so the user's folder is untouched)
//   --eval <global>        writes JSON.stringify(globalThis.<global>) after each shot to `<out>-<seconds>.txt`
//   --region x,y,w,h       crop, in canvas pixels (the game's framebuffer coordinates)
//   --max <px>             downscale so the longer side is at most px (default 512, 0 = full size); applies to shots, difference pictures and the sheet
//   --diff <ref.png>       per shot: mean and max channel difference, share of pixels differing by more than 8/255 and their bounding box (in the cropped
//                          picture, full resolution). The reference is either a full-canvas picture (cropped by --region too) or already the size of the crop
//   --diff-out             also writes `<out>-<seconds>-diff.png`, the difference amplified four times
//   --sheet                also writes `<out>-sheet.png`, all shots in a grid within --max
// Example, crop plus numeric diff against an earlier full shot: `--query file=1,warp=0x422 --out out/shots/b --seconds 6 --every 6 --region 400,300,320,240 --diff out/shots/a-6.png --diff-out`
// Needs `dist/` from `npm run port`. Pictures come from the ROM: keep them under `out/`.
// Needs `dist/` from `npm run port`. Pictures come from the ROM: keep them under `out/`.
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { Cdp, CHROME_SILENT_FLAGS, sleep, waitFor } from './cdp.ts';
import { contactSheet, crop, diffImage, diffStats, downscale, formatDiff, parseRegion } from '../gfx/image-ops.ts';
import { encodePng } from '../gfx/png.ts';
import type { RgbaImage } from '../gfx/types.ts';
import { decodePng } from '../tex/png-read.ts';

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
    region: { type: 'string' },
    max: { type: 'string', default: '512' },
    diff: { type: 'string' },
    'diff-out': { type: 'boolean', default: false },
    frames: { type: 'string' },
    'every-frames': { type: 'string', default: '1' },
    sheet: { type: 'boolean', default: false },
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
const region = values.region ? parseRegion(values.region) : undefined;
const max = Number(values.max);
const reference = values.diff ? decodePng(readFileSync(values.diff)) : undefined;
const frameMode = values.frames !== undefined;
const sheet: RgbaImage[] = [];
const small = (img: RgbaImage) => (max > 0 ? downscale(img, max) : img);
const write = (path: string, img: RgbaImage) => writeFileSync(path, encodePng(img.width, img.height, img.rgba));

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
  await call('Page.navigate', { url: `http://localhost:${port}/?${(frameMode && !/(^|,)capture(=|,|$)/.test(values.query) ? `${values.query},capture` : values.query).replace(/^,/, '').replaceAll(',', '&')}` });
  await waitFor('the first game frame', async () => (JSON.parse((await evaluate('JSON.stringify(globalThis.ootTiming ?? {})')) as string).firstFrame !== undefined ? true : undefined), 120_000);
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'m',code:'KeyM'}))");
  const shoot = async (label: string) => {
    const rect = (await evaluate("(() => { const r = document.getElementById('screen').getBoundingClientRect(); return JSON.stringify([r.x, r.y, r.width, r.height, document.getElementById('screen').width, document.getElementById('screen').height]); })()")) as string;
    const [x, y, width, height, cw, ch] = JSON.parse(rect) as number[];
    const shot = await call<{ data: string }>('Page.captureScreenshot', { format: 'png', clip: { x, y, width, height, scale: 1 } });
    const full = decodePng(Buffer.from(shot.data, 'base64'));
    // The region is in canvas pixels; the picture is in CSS pixels.
    let img = region ? crop(full, { x: (region.x * full.width) / cw!, y: (region.y * full.height) / ch!, w: (region.w * full.width) / cw!, h: (region.h * full.height) / ch! }) : full;
    let line = `${label} canvas ${cw}x${ch}`;
    if (reference) {
      const ref = region && reference.width === full.width && reference.height === full.height
        ? crop(reference, { x: (region.x * full.width) / cw!, y: (region.y * full.height) / ch!, w: (region.w * full.width) / cw!, h: (region.h * full.height) / ch! })
        : reference;
      line += ` ${formatDiff(diffStats(img, ref))}`;
      if (values['diff-out']) write(`${values.out}-${label}-diff.png`, small(diffImage(img, ref)));
    }
    img = small(img);
    write(`${values.out}-${label}.png`, img);
    sheet.push(img);
    console.log(`${line} -> ${values.out}-${label}.png ${img.width}x${img.height}`);
    if (values.eval) writeFileSync(`${values.out}-${label}.txt`, String(await evaluate(`JSON.stringify(globalThis.${values.eval})`)));
  };
  if (frameMode) {
    const step = Number(values['every-frames']);
    await waitFor('ootStep', async () => ((await evaluate('typeof globalThis.ootStep')) === 'function' ? true : undefined));
    for (let n = 1; n <= Number(values.frames); n++) {
      await evaluate(`globalThis.ootStep(${step}, 0, 0)`);
      await shoot(`f${n * step}`);
    }
  } else {
    const total = Number(values.seconds), every = Number(values.every);
    for (let t = every; t <= total; t = Math.round((t + every) * 100) / 100) {
      await sleep(every * 1000);
      if (values['save-at'] && t === Number(values['save-at'])) for (const type of ['keyDown', 'keyUp']) await call('Input.dispatchKeyEvent', { type, key: '5', code: 'Digit5', text: type === 'keyDown' ? '5' : undefined });
      if (t < Number(values.from)) continue;
      await shoot(`${t}`);
    }
  }
  if (values.sheet && sheet.length) {
    const s = contactSheet(sheet, Math.ceil(Math.sqrt(sheet.length)), max > 0 ? max : Infinity);
    write(`${values.out}-sheet.png`, s);
    console.log(`sheet ${values.out}-sheet.png ${s.width}x${s.height}`);
  }
  console.log((await evaluate("document.getElementById('status')?.textContent")) ?? '');
  cdp.close();
} finally {
  for (const c of children) if (c.pid) spawn('taskkill', ['/pid', String(c.pid), '/t', '/f'], { stdio: 'ignore' });
  setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome still holds a file */ } }, 2000).unref();
}
