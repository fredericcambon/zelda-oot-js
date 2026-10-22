// `npx tsx tools/port/measure-load.ts [--port N] [--visits 3] [--assert]`: opens the page served by the dev server in
// headless Chrome and prints the time to the first game frame, for a first visit (empty profile) and for later visits
// (same profile, so the HTTP cache is warm). The page publishes its milestones as `globalThis.ootTiming`.
import { type ChildProcess, spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createChromeProfile, removeChromeProfile , spawnChrome } from '../lib/chrome-profile.ts';
import { Cdp, CHROME_SILENT_FLAGS, waitFor } from './cdp.ts';

const FIRST_FRAME_LIMIT_MS = 1500;
const REPEAT_FRAME_LIMIT_MS = 1000;

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: process.env.PORT ?? '5199' },
    visits: { type: 'string', default: '3' },
    chrome: { type: 'string', default: 'C:/Program Files/Google/Chrome/Application/chrome.exe' },
    assert: { type: 'boolean', default: false },
  },
});
const port = Number(values.port);
const url = `http://localhost:${port}/`;
interface Visit {
  firstFrameMs: number;
  marks: Record<string, number>;
  requests: number;
  wasmRequests: number;
  bytes: number;
}

async function visit(cdp: Cdp): Promise<Visit> {
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
  const urls = new Map<string, string>();
  let bytes = 0;
  cdp.on((method, p, session) => {
    if (session !== sessionId) return;
    if (method === 'Network.requestWillBeSent') urls.set(p.requestId as string, (p.request as { url: string }).url);
    if (method === 'Network.loadingFinished') bytes += p.encodedDataLength as number;
  });
  await cdp.send('Network.enable', {}, sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);
  const evaluate = async (expression: string) =>
    (await cdp.send<{ result: { value?: unknown } }>('Runtime.evaluate', { expression, returnByValue: true }, sessionId)).result.value;
  const marks = await waitFor('the first game frame', async () => {
    const m = (await evaluate('JSON.stringify(globalThis.ootTiming ?? {})')) as string | undefined;
    const parsed = m ? (JSON.parse(m) as Record<string, number>) : {};
    if (parsed.firstFrame !== undefined) return parsed;
    const status = (await evaluate("document.getElementById('status')?.className")) as string | undefined;
    if (status === 'error') throw new Error(`the page failed: ${await evaluate("document.getElementById('status').textContent")}`);
    return undefined;
  });
  const all = [...urls.values()];
  const result = {
    firstFrameMs: marks.firstFrame!,
    marks,
    requests: all.length,
    wasmRequests: all.filter((u) => new URL(u).pathname.endsWith('.wasm')).length,
    bytes,
  };
  await cdp.send('Target.closeTarget', { targetId });
  return result;
}

const children: ChildProcess[] = [];
const profile = createChromeProfile('load');
let chrome: ChildProcess | undefined;
try {
  const vite = spawn('npx', ['vite', '--config', 'vite.config.ts', '--port', String(port), '--strictPort'], { stdio: 'ignore', shell: true });
  children.push(vite);
  await waitFor('the dev server', async () => ((await fetch(url)).ok ? true : undefined));

  const debugPort = port + 1;
  chrome = spawnChrome(values.chrome!, [
    '--headless=new', ...CHROME_SILENT_FLAGS, `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', 'about:blank',
  ], { stdio: 'ignore' });
  children.push(chrome);
  const wsUrl = await waitFor('Chrome', async () => ((await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl);
  const cdp = await Cdp.open(wsUrl);

  const visits: Visit[] = [];
  for (let i = 0; i < Number(values.visits); i++) visits.push(await visit(cdp));
  cdp.close();
  visits.forEach((v, i) => {
    const marks = Object.entries(v.marks).map(([k, t]) => `${k} ${t.toFixed(0)}`).join(', ');
    console.log(`${i === 0 ? 'first visit' : `visit ${i + 1}  `}: first frame ${v.firstFrameMs.toFixed(0)} ms | ${v.requests} requests, ${v.wasmRequests} wasm, ${(v.bytes / 1e6).toFixed(1)} MB transferred | ${marks}`);
  });
  if (values.assert) {
    const repeats = visits.slice(1);
    const bad = [
      ...(visits[0]!.firstFrameMs > FIRST_FRAME_LIMIT_MS ? [`first visit ${visits[0]!.firstFrameMs.toFixed(0)} ms > ${FIRST_FRAME_LIMIT_MS}`] : []),
      ...repeats.filter((v) => v.firstFrameMs > REPEAT_FRAME_LIMIT_MS).map((v) => `repeat visit ${v.firstFrameMs.toFixed(0)} ms > ${REPEAT_FRAME_LIMIT_MS}`),
    ];
    if (bad.length > 0) throw new Error(bad.join('; '));
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  for (const c of children) if (c.pid) spawn('taskkill', ['/pid', String(c.pid), '/t', '/f'], { stdio: 'ignore' });
  await removeChromeProfile(profile, chrome);
}
