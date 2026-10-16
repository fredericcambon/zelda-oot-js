import { AudioOutput } from './audio.ts';
import { startGame, type Game } from './game.ts';
import { Renderer, type CullMode } from './renderer.ts';
import { loadCartridge } from './cartridge.ts';
import { Input } from './input.ts';
import { indexedDbStore, SaveSync } from './saves.ts';
import { indexedDbStates, SaveStates } from './savestate.ts';

const FRAME_MS = 20; // the video interface retraces at 50 Hz

const status = document.getElementById('status')!;
const overlay = document.getElementById('overlay') as HTMLPreElement;
const canvas = document.getElementById('screen') as HTMLCanvasElement;
const notice = document.getElementById('notice')!;

if (location.hash === '#debug') overlay.hidden = false;

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
let fps = 0;

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
  if (e.key === 'F3') {
    overlay.hidden = !overlay.hidden;
    e.preventDefault();
  } else if (e.key === 'n' || e.key === 'N') {
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

function updateOverlay(): void {
  if (overlay.hidden) return;
  const s = renderer.stats;
  const g = game?.info();
  overlay.textContent = [
    `${fps.toFixed(0)} fps (game 50 Hz)`,
    g ? `frame ${g.frames}  retraces ${g.retraces}  gfx tasks ${g.gfxTasks}${g.idle ? '  IDLE' : ''}` : 'no game',
    `last task: ${s.commands} commands, ${s.batches} batches, ${s.triangles} triangles, ${s.rects} rects`,
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
    const now = performance.now();
    // At most three frames of catch-up, so a stalled tab does not trigger a burst.
    acc = Math.min(acc + now - last, FRAME_MS * 3);
    last = now;
    let stepped = false;
    while (acc >= FRAME_MS && game) {
      acc -= FRAME_MS;
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
    if (game && stepped) renderer.present(game.framebuffer());
    if (now - countStart >= 1000) {
      fps = (counted * 1000) / (now - countStart);
      counted = 0;
      countStart = now;
    }
    updateOverlay();
  }
  updateOverlay();
}

async function boot(): Promise<void> {
  try {
    const rom = await loadCartridge((done, total) => setStatus(`Loading game files: ${done} / ${total}`));
    setStatus('Starting...');
    const started = await startGame(rom, renderer, audio);
    const sync = new SaveSync(started.saveMemory, indexedDbStore());
    await sync.restore();
    saves = sync;
    try {
      states = new SaveStates(started.states, indexedDbStates(), await started.buildId());
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
