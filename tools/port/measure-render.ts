// `npx tsx tools/port/measure-render.ts --state <state-1.bin> [--port N] [--seconds 30] [--headless] [--no-walk] [--out dir]`:
// loads a save state taken in Kokiri Forest (press 5 on the page; the file is `state-1.bin` in the saves folder,
// `~/.zelda-oot-js/saves`) in 60 Hz mode in Chrome on the GPU and measures the page with Smooth off, on by default, and on at
// 50 % strength / 50 % catch-up: requestAnimationFrame intervals, the debug overlay's per-phase means, draw calls and GPU time.
// The state is copied to a temporary saves folder, so the player's saves are not touched. Headed Chrome by default
// (`--headless` adds --use-angle=d3d11 --enable-gpu; a headed window that is covered or minimised is throttled to 1 frame per
// second, so leave it alone). The WebGL renderer string is printed: a SwiftShader one aborts the run.
import { type ChildProcess, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Cdp, CHROME_SILENT_FLAGS, sleep, waitFor } from './cdp.ts';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: process.env.PORT ?? '5299' },
    seconds: { type: 'string', default: '30' },
    chrome: { type: 'string', default: 'C:/Program Files/Google/Chrome/Application/chrome.exe' },
    headless: { type: 'boolean', default: false },
    'no-walk': { type: 'boolean', default: false },
    state: { type: 'string' },
    out: { type: 'string', default: 'out/measure-render' },
  },
});
const port = Number(values.port);
const seconds = Number(values.seconds);
const url = `http://localhost:${port}/`;

interface Config {
  name: string;
  smooth: boolean;
  strength: number;
  span: number;
}
const CONFIGS: Config[] = [
  { name: 'Smooth off', smooth: false, strength: 100, span: 100 },
  { name: 'Smooth on (strength 100 %, catch-up 100 %)', smooth: true, strength: 100, span: 100 },
  { name: 'Smooth on (strength 50 %, catch-up 50 %)', smooth: true, strength: 50, span: 50 },
];

/** Recorded in the page: the timestamp of each requestAnimationFrame callback while `__rafOn` is set. */
const INIT_SCRIPT = `
  localStorage.setItem('zelda-oot-js:60hz', '1');
  localStorage.setItem('oot.smooth', '0');
  window.__raf = [];
  window.__rafOn = false;
  const tick = (t) => { if (window.__rafOn) window.__raf.push(t); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
`;

/** The forest's display lists have 5,000 to 6,500 commands, the houses' about 2,500. */
const FOREST_COMMANDS = 4000;

const KEYS: Record<string, { key: string; vk: number }> = {
  Digit6: { key: '6', vk: 54 },
  ArrowLeft: { key: 'ArrowLeft', vk: 37 }, ArrowRight: { key: 'ArrowRight', vk: 39 },
};

function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

function intervalsOf(stamps: number[]): number[] {
  return stamps.slice(1).map((t, i) => t - stamps[i]!);
}

function summarize(intervals: number[], refresh: number) {
  const sorted = [...intervals].sort((a, b) => a - b);
  const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  return {
    frames: intervals.length,
    mean,
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    max: sorted[sorted.length - 1]!,
    overPct: (intervals.filter((v) => v > 1.5 * refresh).length / intervals.length) * 100,
  };
}

/** A number printed by the overlay after `label`, or null (n/a, absent). */
function overlayNumber(text: string, label: RegExp): number | null {
  const m = label.exec(text);
  return m ? Number(m[1]) : null;
}

function mean(values: (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null);
  return v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length;
}

interface Row {
  gameFps: number | null;
  shownFps: number | null;
  gameCode: number | null;
  displayLists: number | null;
  submit: number | null;
  gpu: number | null;
  total: number | null;
  drawCalls: number | null;
}

const children: ChildProcess[] = [];
const work = mkdtempSync(join(tmpdir(), 'oot-measure-'));
try {
  const saves = join(work, 'saves');
  mkdirSync(saves);
  if (!values.state || !existsSync(values.state)) throw new Error('--state <state-1.bin> is required (a state saved in Kokiri Forest, 60 Hz mode)');
  copyFileSync(values.state, join(saves, 'state-1.bin'));
  if (existsSync(`${values.state}.format`)) copyFileSync(`${values.state}.format`, join(saves, 'state-1.bin.format'));
  if (await fetch(url).then(() => true, () => false)) throw new Error(`something already answers on port ${port}; pass another --port`);
  const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'vite.config.ts', '--port', String(port), '--strictPort'], { stdio: 'ignore', env: { ...process.env, OOT_SAVES_DIR: saves } });
  children.push(vite);
  await waitFor('the dev server', async () => ((await fetch(url)).ok ? true : undefined));

  const debugPort = port + 1;
  const chrome = spawn(values.chrome!, [
    ...(values.headless ? ['--headless=new', '--use-angle=d3d11', '--enable-gpu'] : []),
    ...CHROME_SILENT_FLAGS,
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${join(work, 'profile')}`, '--no-first-run', '--no-default-browser-check',
    '--ignore-gpu-blocklist', '--enable-webgl-developer-extensions', '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--window-size=1280,960', 'about:blank',
  ], { stdio: 'ignore' });
  children.push(chrome);
  const wsUrl = await waitFor('Chrome', async () => ((await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl);
  const cdp = await Cdp.open(wsUrl);
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Target.activateTarget', { targetId });
  const send = <T = Record<string, unknown>>(method: string, params: object = {}) => cdp.send<T>(method, params, sessionId);
  const evaluate = async <T>(expression: string) => (await send<{ result: { value?: T } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value as T;
  const key = async (code: keyof typeof KEYS, down: boolean) => {
    const k = KEYS[code]!;
    await send('Input.dispatchKeyEvent', { type: down ? 'keyDown' : 'keyUp', code, key: k.key, windowsVirtualKeyCode: k.vk });
  };
  const tap = async (code: keyof typeof KEYS, holdMs = 120) => {
    await key(code, true);
    await sleep(holdMs);
    await key(code, false);
  };

  // The display: its refresh interval from a page with nothing else running, and the renderer the browser gives WebGL2.
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: INIT_SCRIPT });
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(500);
  const gpu = await evaluate<{ renderer: string; vendor: string; timer: boolean; refreshMs: number }>(`(async () => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const stamps = [];
    await new Promise((done) => { const f = (t) => { stamps.push(t); stamps.length < 241 ? requestAnimationFrame(f) : done(); }; requestAnimationFrame(f); });
    const d = stamps.slice(1).map((t, i) => t - stamps[i]).sort((a, b) => a - b);
    return { renderer: gl.getParameter(info.UNMASKED_RENDERER_WEBGL), vendor: gl.getParameter(info.UNMASKED_VENDOR_WEBGL),
             timer: !!gl.getExtension('EXT_disjoint_timer_query_webgl2'), refreshMs: d[Math.floor(d.length / 2)] };
  })()`);
  const refreshHz = 1000 / gpu.refreshMs;
  // The nominal refresh interval (the median is within a fraction of a millisecond of it).
  const refresh = 1000 / Math.round(refreshHz);
  console.log(`GPU: ${gpu.renderer} (${gpu.vendor}); EXT_disjoint_timer_query_webgl2: ${gpu.timer ? 'yes' : 'no'}; display ~${refreshHz.toFixed(1)} Hz (median rAF ${gpu.refreshMs.toFixed(2)} ms), reference ${refresh.toFixed(2)} ms`);
  if (/swiftshader|llvmpipe|software/i.test(gpu.renderer)) throw new Error(`WebGL runs on a software renderer (${gpu.renderer}), not a GPU`);

  const shot = async (name: string) => {
    mkdirSync(values.out!, { recursive: true });
    const { data } = await send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(values.out!, name), Buffer.from(data, 'base64'));
  };

  // Boot, then load the state.
  await send('Page.navigate', { url: `${url}#debug` });
  await waitFor('the game', async () => ((await evaluate<string>("document.getElementById('status')?.textContent")) === 'Running' ? true : undefined), 120_000);
  await send('Page.bringToFront');
  await sleep(2000);
  await tap('Digit6');
  await sleep(1000);
  console.log(`load state: ${await evaluate<string>("document.getElementById('notice').textContent")}`);
  await sleep(2000);
  const overlay = () => evaluate<string>("document.getElementById('overlay').textContent");
  // Shaders and textures compile on first use and stall the page; measure once the game runs at its full rate.
  await waitFor('the game at full rate', async () => ((overlayNumber(await overlay(), /game ([\d.]+) frames\/s/) ?? 0) > 19 ? true : undefined), 90_000);
  await sleep(10_000);
  await shot('forest.png');
  console.log(`state: ${await evaluate<string>("JSON.stringify({ hz: localStorage.getItem('zelda-oot-js:60hz'), smooth: localStorage.getItem('oot.smooth'), strength: localStorage.getItem('oot.smooth.strength'), span: localStorage.getItem('oot.smooth.span'), focus: document.hasFocus() })")}`);

  // Link steps left and right on the spot so he and the camera move; a standing Link would flatter Smooth.
  let walking = !values['no-walk'];
  const walker = (async () => {
    const dirs = ['ArrowLeft', 'ArrowRight'] as const;
    for (let i = 0; walking; i++) {
      const dir = dirs[i % 2]!;
      await key(dir, true);
      await sleep(400);
      await key(dir, false);
    }
  })();

  const results: { config: Config; rafs: ReturnType<typeof summarize>; overlay: Row }[] = [];
  // The smooth controls are on the Graphics tab.
  await evaluate("document.getElementById('tab-graphics').click()");
  await sleep(300);
  for (const config of CONFIGS) {
    await evaluate(`(() => {
      const t = document.getElementById('smooth-toggle');
      if ((t.getAttribute('aria-pressed') === 'true') !== ${config.smooth}) t.click();
      for (const [id, v] of [['smooth-strength', ${config.strength}], ['smooth-span', ${config.span}]]) {
        const e = document.getElementById(id); e.value = String(v); e.dispatchEvent(new Event('input'));
      }
      window.__raf.length = 0;
    })()`);
    await sleep(8000);
    await evaluate('window.__raf.length = 0; window.__rafOn = true');
    const samples: string[] = [];
    for (let t = 0; t < seconds; t += 2) {
      await sleep(2000);
      samples.push(await overlay());
    }
    const commands = samples.map((t) => overlayNumber(t, /last task: (\d+) commands/) ?? 0);
    if (Math.min(...commands) < FOREST_COMMANDS) throw new Error(`${config.name}: Link left the forest (display lists of ${Math.min(...commands)} commands)`);
    const stamps = await evaluate<number[]>("(window.__rafOn = false, window.__raf)");
    if (!stamps) throw new Error("no rAF stamps: " + JSON.stringify(await evaluate("typeof window.__raf + location.href")));
    const num = (label: RegExp) => mean(samples.map((s) => overlayNumber(s, label)));
    const row: Row = {
      gameFps: num(/game ([\d.]+) frames\/s/),
      shownFps: num(/displayed ([\d.]+) fps/),
      gameCode: num(/game code\s+([\d.]+) ms/),
      displayLists: num(/display lists\s+([\d.]+) ms/),
      submit: num(/submit\s+([\d.]+) ms/),
      gpu: num(/GPU\s+([\d.]+) ms/),
      total: num(/total \(CPU\)\s+([\d.]+) ms/),
      drawCalls: num(/draw calls\s+([\d.]+)/),
    };
    results.push({ config, rafs: summarize(intervalsOf(stamps), refresh), overlay: row });
    console.log(`${config.name}: ${JSON.stringify(results.at(-1)!.rafs)} ${JSON.stringify(row)}`);
    await shot(`${config.smooth ? `smooth-${config.strength}-${config.span}` : 'off'}.png`);
  }
  walking = false;
  await walker;
  cdp.close();

  const f = (v: number | null, d = 2) => (v === null ? 'n/a' : v.toFixed(d));
  console.log(`\nGPU ${gpu.renderer}; display ${refreshHz.toFixed(1)} Hz; ${seconds} s per row; "over 1.5x" is above ${(1.5 * refresh).toFixed(1)} ms\n`);
  console.log('| Mode | rAF mean (ms) | p95 | p99 | max | frames over 1.5x | game fps | game code (ms) | display lists | submit | CPU per refresh | GPU (per sample) | draw calls per game frame | per refresh |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const { config, rafs, overlay: o } of results) {
    // The overlay's means are per game frame; a refresh gets 1/(refresh rate / game fps) of that.
    const share = o.gameFps === null ? null : o.gameFps / refreshHz;
    const per = (v: number | null) => (v === null || share === null ? null : v * share);
    console.log(`| ${config.name} | ${f(rafs.mean)} | ${f(rafs.p95)} | ${f(rafs.p99)} | ${f(rafs.max)} | ${f(rafs.overPct, 1)} % | ${f(o.gameFps, 1)} | ${f(o.gameCode, 3)} | ${f(o.displayLists, 3)} | ${f(o.submit, 3)} | ${f(per(o.total), 2)} | ${f(o.gpu, 3)} | ${f(o.drawCalls, 1)} | ${f(per(o.drawCalls), 1)} |`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  for (const c of children) if (c.pid) spawn('taskkill', ['/pid', String(c.pid), '/t', '/f'], { stdio: 'ignore' });
  await sleep(1000);
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // Chrome may still hold a profile file; the folder is in the temp directory.
  }
}
