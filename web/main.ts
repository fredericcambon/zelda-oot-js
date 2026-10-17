import { AudioOutput } from './audio.ts';
import { startGame, type Game } from './game.ts';
import { Renderer, type CullMode } from './renderer.ts';
import { loadCartridge } from './cartridge.ts';
import { Input } from './input.ts';
import { indexedDbStore, SaveSync, serverHasSaves, serverStore } from './saves.ts';
import { indexedDbStates, SaveStates, serverStates } from './savestate.ts';
import { migrateToServer } from './migrate.ts';
import { FastForward } from './fastforward.ts';
import { formatBreakdown } from '../tools/gfx/profile.ts';

const FAST_BUDGET_MS = 12;
const FRAME_MS = 20; // the video interface retraces at 50 Hz

const status = document.getElementById('status')!;
const overlay = document.getElementById('overlay') as HTMLPreElement;
const canvas = document.getElementById('screen') as HTMLCanvasElement;
const notice = document.getElementById('notice')!;

if (location.hash === '#debug') overlay.hidden = false;
const debugToggle = document.getElementById('debug-toggle') as HTMLButtonElement;
// Not focusable by mouse (mousedown is cancelled) so the game keeps the keyboard.
debugToggle.addEventListener('mousedown', (e) => e.preventDefault());
debugToggle.addEventListener('click', () => {
  overlay.hidden = !overlay.hidden;
  debugToggle.blur();
});

const SMOOTH_KEY = 'oot.smooth';
const readSmooth = (): boolean => {
  try {
    return localStorage.getItem(SMOOTH_KEY) === '1';
  } catch {
    return false;
  }
};
const writeSmooth = (on: boolean): void => {
  try {
    localStorage.setItem(SMOOTH_KEY, on ? '1' : '0');
  } catch {
    // Storage may be blocked; the choice then lasts until the page is closed.
  }
};
let smoothOn = readSmooth();
const smoothToggle = document.getElementById('smooth-toggle') as HTMLButtonElement;
smoothToggle.setAttribute('aria-pressed', String(smoothOn));
smoothToggle.addEventListener('mousedown', (e) => e.preventDefault());
smoothToggle.addEventListener('click', () => {
  smoothOn = !smoothOn;
  smoothToggle.setAttribute('aria-pressed', String(smoothOn));
  writeSmooth(smoothOn);
  smoothToggle.blur();
});

const setStatus = (text: string, error = false) => {
  status.textContent = text;
  status.classList.toggle('error', error);
};

// Whole multiples of the 320x240 the game addresses, enough to fill the canvas as displayed.
const displayScale = () => Math.min(4, Math.max(1, Math.ceil((canvas.clientWidth * devicePixelRatio) / 320)));

let renderer: Renderer;
try {
  renderer = new Renderer(canvas, displayScale());
} catch (err) {
  setStatus(err instanceof Error ? err.message : String(err), true);
  throw err;
}

let game: Game | null = null;
let saves: SaveSync | null = null;
let states: SaveStates | null = null;
// The save state key last pressed, run between two frames: the game cannot be copied while a frame is in progress.
let pendingState: (() => Promise<string>) | null = null;
let noticeTimer = 0;
const input = new Input();
const audio = new AudioOutput();
const fastForward = new FastForward();
// Sound is dropped while fast-forwarding: the buffers would pile up faster than they play.
const sound = { push: (bytes: Uint8Array, hz: number) => { if (!fastForward.active) audio.push(bytes, hz); } };
addEventListener('keydown', (e) => fastForward.keydown(e));
addEventListener('keyup', (e) => fastForward.keyup(e));
addEventListener('blur', () => fastForward.reset());
let fps = 0;
let shownFps = 0;

// Browsers start sound only from a user gesture; any key or click does it.
const enableSound = () => {
  audio.resume().catch((err) => console.error('sound is not available:', err));
};
addEventListener('keydown', enableSound);
addEventListener('pointerdown', enableSound);

const showNotice = (text: string) => {
  notice.textContent = text;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => (notice.hidden = true), 2000);
};

// 5 saves to the current slot, 6 loads it and 7 moves to the next slot.
const STATE_KEYS: Record<string, (s: SaveStates) => Promise<string>> = {
  '5': (s) => s.save(),
  '6': (s) => s.load(),
  '7': (s) => s.select(1),
};
addEventListener('keydown', (e) => {
  const action = STATE_KEYS[e.key];
  if (!action || e.ctrlKey || e.metaKey || e.altKey) return;
  e.preventDefault();
  if (e.repeat) return;
  if (!states) {
    showNotice('Save states are not available yet');
    return;
  }
  const target = states;
  pendingState = () => action(target);
});

const CULL_MODES: CullMode[] = ['normal', 'swapped', 'off'];
addEventListener('keydown', (e) => {
  if (e.key === 'n' || e.key === 'N') {
    // Native 320x240, shown with hard pixels, for comparing with the console's resolution.
    const native = renderer.resolutionScale !== 1;
    renderer.setScale(native ? 1 : displayScale());
    canvas.classList.toggle('native', native);
  } else if (e.key === 'm' || e.key === 'M') {
    audio.toggleMute();
  } else if (e.key === 'c' || e.key === 'C') {
    renderer.cullMode = CULL_MODES[(CULL_MODES.indexOf(renderer.cullMode) + 1) % CULL_MODES.length]!;
  }
});

function smoothLines(): string[] {
  if (!smoothOn) return [];
  if (fastForward.active) return ['smooth: off while fast-forwarding'];
  const info = game?.smoothInfo();
  if (!info) return ['smooth: on, waiting for two game frames'];
  const share = info.threeD === 0 ? 100 : (info.matched / info.threeD) * 100;
  return [`smooth: on, ${info.matched} of ${info.threeD} 3D matrices matched (${share.toFixed(1)}%)${info.cut ? ', cut: drawn as is' : ''}, vertices written by the game ${(info.rewritten * 100).toFixed(1)}%`];
}

function updateOverlay(): void {
  if (overlay.hidden) return;
  const s = renderer.stats;
  const g = game?.info();
  overlay.textContent = [
    `${fps.toFixed(0)} fps (game 50 Hz)  displayed ${shownFps.toFixed(0)} fps`,
    ...smoothLines(),
    g ? `frame ${g.frames}  retraces ${g.retraces}  gfx tasks ${g.gfxTasks}${g.idle ? '  IDLE' : ''}` : 'no game',
    `last task: ${s.commands} commands, ${s.batches} batches, ${s.triangles} triangles, ${s.rects} rects`,
    ...(game ? formatBreakdown(game.profiler.breakdown()) : []),
    `unknown commands ${s.unknown}  problems ${s.problems.length}`,
    `programs ${s.programs}  textures ${s.textures}  colour images ${s.targets}`,
    game ? `video framebuffer 0x${game.framebuffer().toString(16)}` : '',
    `culling ${renderer.cullMode}  resolution ${renderer.resolutionScale}x`,
    g ? `audio tasks ${g.audioTasks}  sound ${audio.state === 'running' ? `on, level ${audio.level().toFixed(3)}` : 'off: press a key'}` : '',
    g?.renderError ? `render error: ${g.renderError}` : '',
    g?.audioError ? `audio error: ${g.audioError}` : '',
    ...s.problems,
  ].filter(Boolean).join('\n');
}

async function loop(): Promise<void> {
  let last = performance.now();
  let acc = 0;
  let counted = 0;
  let presented = 0;
  let countStart = last;
  while (game) {
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    if (pendingState) {
      const run = pendingState;
      pendingState = null;
      try {
        showNotice(await run());
      } catch (err) {
        showNotice(`Save state failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      last = performance.now();
    }
    // Fast-forward runs frames back to back and has no time for in-between pictures.
    game?.setSmooth(smoothOn && !fastForward.active);
    const now = performance.now();
    // At most three frames of catch-up, so a stalled tab does not trigger a burst.
    acc = Math.min(acc + now - last, FRAME_MS * 3);
    last = now;
    let stepped = false;
    // Fast-forward: frames back to back for most of the display interval.
    const budgetEnd = now + FAST_BUDGET_MS;
    while (game && (fastForward.active ? !stepped || performance.now() < budgetEnd : acc >= FRAME_MS)) {
      acc = fastForward.active ? 0 : acc - FRAME_MS;
      try {
        game.setPad(input.poll());
        await game.frame();
        saves?.flush().catch((err) => setStatus(`Could not store the save: ${err instanceof Error ? err.message : String(err)}`, true));
      } catch (err) {
        setStatus(`The game stopped: ${err instanceof Error ? err.message : String(err)}`, true);
        game = null;
        break;
      }
      counted++;
      stepped = true;
    }
    if (game) {
      const smooth = game.drawSmooth(acc / FRAME_MS);
      if (smooth !== null || stepped) {
        const t0 = performance.now();
        renderer.present(smooth ?? game.framebuffer());
        game.profiler.addSubmit(performance.now() - t0);
        presented++;
      }
    }
    if (now - countStart >= 1000) {
      fps = (counted * 1000) / (now - countStart);
      shownFps = (presented * 1000) / (now - countStart);
      counted = 0;
      presented = 0;
      countStart = now;
    }
    updateOverlay();
  }
  updateOverlay();
}

async function boot(): Promise<void> {
  try {
    const onServer = await serverHasSaves();
    const rom = await loadCartridge((done, total) => setStatus(`Loading game files: ${done} / ${total}`));
    setStatus('Starting...');
    const started = await startGame(rom, renderer, sound);
    if (onServer) {
      const moved = await migrateToServer(
        { sram: indexedDbStore(), states: indexedDbStates() },
        { sram: serverStore(), states: serverStates() },
        (what, err) => console.error(`could not move ${what} to the saves folder:`, err),
      );
      if (moved.length > 0) showNotice(`Moved saves to the saves folder: ${moved.join(', ')}`);
    }
    const sync = new SaveSync(started.saveMemory, onServer ? serverStore() : indexedDbStore());
    await sync.restore();
    saves = sync;
    try {
      states = new SaveStates(started.states, onServer ? serverStates() : indexedDbStates(), await started.buildId());
    } catch (err) {
      console.error('save states are not available:', err);
    }
    game = started;
    setStatus('Running');
    void loop();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
  }
}

void boot();
