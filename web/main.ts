import { startGame, type Game } from './game.ts';
import { Renderer, type CullMode } from './renderer.ts';
import { loadRomImage } from './rom.ts';

const FRAME_MS = 20; // the video interface retraces at 50 Hz

const status = document.getElementById('status')!;
const overlay = document.getElementById('overlay') as HTMLPreElement;
const canvas = document.getElementById('screen') as HTMLCanvasElement;

if (location.hash === '#debug') overlay.hidden = false;

const setStatus = (text: string, error = false) => {
  status.textContent = text;
  status.classList.toggle('error', error);
};

let renderer: Renderer;
try {
  renderer = new Renderer(canvas);
} catch (err) {
  setStatus(err instanceof Error ? err.message : String(err), true);
  throw err;
}

let game: Game | null = null;
let fps = 0;

const CULL_MODES: CullMode[] = ['normal', 'swapped', 'off'];
addEventListener('keydown', (e) => {
  if (e.key === 'F3') {
    overlay.hidden = !overlay.hidden;
    e.preventDefault();
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
    `culling ${renderer.cullMode}`,
    g?.renderError ? `render error: ${g.renderError}` : '',
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
    const now = performance.now();
    // At most three frames of catch-up, so a stalled tab does not trigger a burst.
    acc = Math.min(acc + now - last, FRAME_MS * 3);
    last = now;
    let stepped = false;
    while (acc >= FRAME_MS && game) {
      acc -= FRAME_MS;
      try {
        await game.frame();
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
    const rom = await loadRomImage((done, total) => setStatus(`Loading game files: ${done} / ${total}`));
    setStatus('Starting...');
    game = await startGame(rom, renderer);
    setStatus('Running');
    void loop();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
  }
}

void boot();
