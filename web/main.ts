import { AudioOutput } from './audio.ts';
import { startGame, type Game } from './game.ts';
import { Renderer, type CullMode } from './renderer.ts';
import { FILTER_MODES, loadSettings, renderScale, saveSettings, type GfxSettings } from './gfx-settings.ts';
import { loadCartridge } from './cartridge.ts';
import { Input, mergePads } from './input.ts';
import { toggleFullscreen, TouchControls } from './touch.ts';
import { indexedDbStore, SaveSync, serverHasSaves, serverStore } from './saves.ts';
import { loadPublished, withPublishedSram, withPublishedStates } from './published-saves.ts';
import { indexedDbStates, SaveStates, serverStates } from './savestate.ts';
import { STATE_VERSION } from '../tools/runtime/snapshot.ts';
import { migrateToServer } from './migrate.ts';
import { FastForward } from './fastforward.ts';
import { formatBreakdown } from '../tools/gfx/profile.ts';
import { fetchWasm, preloadModule } from './wasm.ts';
import { mark, timingLines } from './timing.ts';
import { FramePacer, loadHz, saveHz, type Hz } from './mode.ts';
import { AutoStart, fileSelectReached, guestRam, loadRecordIntoPlay, unsafeReason } from '../tools/headless/load-save.ts';
import { playState } from '../tools/headless/state.ts';
import { parseBootParams, type BootParams } from './boot-params.ts';
import { getRecord } from '../tools/saves/image.ts';
import { backToFileSelect, loadSaveFile, loadSlotIntoPlay, type SaveTarget } from './save-actions.ts';
import { pickSaveFile } from './save-picker.ts';
import { EMPTY_INVENTORY, editContext, inventorySnapshot, sameInventory, toggleFreeze } from './inspect/inventory.ts';
import { Bridge, readEntrances, sameSnapshot, snapshot, warpTo } from './inspect/index.ts';
import { applyCheats, loadCheats, parseCode, saveCheats, type Cheat } from './inspect/cheats.ts';
import { loadLightIds, saveLightIds, toggleId } from './inspect/light-labels.ts';
import { EMPTY_ACTORS, goToActor, sameSnapshot as sameActors, snapshot as actorsSnapshot } from './inspect/actors.ts';
import { EMPTY_MEMORY, MemoryModel, parseAddress } from './inspect/memory.ts';
import { labels } from './ui/labels.ts';
import { mountUi } from './ui/panel.ts';
import { Store } from './ui/store.ts';
import { TitleEdition } from './title-edition.ts';
import { isTyping } from './ui/typing.ts';
import type { UiActions, UiState } from './ui/types.ts';

const FAST_BUDGET_MS = 12;
const SLOW_LOAD_MS = 500;

const status = document.getElementById('status')!;
const overlay = document.getElementById('overlay') as HTMLPreElement;
const canvas = document.getElementById('screen') as HTMLCanvasElement;
const notice = document.getElementById('notice')!;
const edition = new TitleEdition(canvas.parentElement!, overlay);

const SMOOTH_KEY = 'oot.smooth';
const readSmooth = (): boolean => {
  try {
    const raw = localStorage.getItem(SMOOTH_KEY);
    return raw === null ? true : raw === '1';
  } catch {
    return true;
  }
};
const writeSmooth = (on: boolean): void => {
  try {
    localStorage.setItem(SMOOTH_KEY, on ? '1' : '0');
  } catch {
    // Storage may be blocked; the choice then lasts until the page is closed.
  }
};

// Percent sliders: how much motion is shown and how fast it catches up to the current game frame.
const readTuning = (key: string, min: number, max: number, fallback: number): number => {
  try {
    const raw = localStorage.getItem(key);
    const stored = Number(raw);
    if (raw !== null && stored >= min && stored <= max) return stored;
  } catch {
    // Storage may be blocked; the default stays.
  }
  return fallback;
};
const writeTuning = (key: string, value: number): void => {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // The choice then lasts until the page is closed.
  }
};
const STRENGTH_KEY = 'oot.smooth.strength';
const SPAN_KEY = 'oot.smooth.span';

// The video rate is chosen when the game boots, so the button only changes what the next page load boots.
const bootHz: Hz = loadHz();

let gfx = loadSettings();

const store = new Store<UiState>({
  smooth: readSmooth(),
  ao: gfx.ao,
  aoStrength: gfx.aoStrength,
  bloom: gfx.bloom,
  bloomStrength: gfx.bloomStrength,
  bloomThreshold: gfx.bloomThreshold,
  bloomKnee: gfx.bloomKnee,
  bloomRadius: gfx.bloomRadius,
  sharpen: gfx.sharpen,
  sharpenStrength: gfx.sharpenStrength,
  lightingMode: gfx.lightingMode,
  pointLights: gfx.pointLights,
  pointLightStrength: gfx.pointLightStrength,
  lightIds: loadLightIds(),
  strength: readTuning(STRENGTH_KEY, 0, 100, 50),
  span: readTuning(SPAN_KEY, 25, 100, 50),
  bootHz,
  wantedHz: bootHz,
  muted: false,
  native: false,
  cull: 'normal',
  controlsHidden: false,
  slot: null,
  filled: [],
  overlayShown: location.hash === '#debug',
  debugText: '',
  debugVisible: false,
  warpVisible: false,
  warp: { live: null, refusal: 'no game is running' },
  inventoryVisible: false,
  inventory: EMPTY_INVENTORY,
  memoryVisible: false,
  memory: EMPTY_MEMORY,
  cheats: loadCheats(),
  actorsVisible: false,
  actors: EMPTY_ACTORS,
  tabRequest: null,
  sheetOpen: false,
});
overlay.hidden = !store.get().overlayShown;

function applyTuning(): void {
  const s = store.get();
  game?.tuneSmooth({ strength: s.strength / 100, span: s.span / 100 });
}

const setStatus = (text: string, error = false) => {
  status.textContent = text;
  status.classList.toggle('error', error);
  status.classList.toggle('ok', text === 'Running');
};

// The 3D image has as many pixels as the canvas has on the display, within the settings' cap.
const displayScale = () => renderScale(canvas.clientWidth, devicePixelRatio, gfx);

// Started now so the module downloads and compiles while the cartridge image loads.
const wasm = fetchWasm();
preloadModule();

let renderer: Renderer;
try {
  renderer = new Renderer(canvas, displayScale(), gfx);
} catch (err) {
  setStatus(err instanceof Error ? err.message : String(err), true);
  throw err;
}
// The handle tools use to read renderer facts from the page (the fit of the occlusion's projection, the settings).
if (location.hash === '#debug') (globalThis as { ootRenderer?: unknown }).ootRenderer = renderer;

renderer.markedLightIds = new Set(store.get().lightIds);

let game: Game | null = null;
let saves: SaveSync | null = null;
let states: SaveStates | null = null;
// Save state and save file actions run between two frames: the game cannot be copied or changed while a frame is in progress.
const bridge = new Bridge(() => game?.ram() ?? null);
const memoryModel = new MemoryModel();
applyCheats(bridge.freezes, store.get().cheats);
// Presses Start after the game started over, until the file select is reached.
let autoStart: AutoStart | null = null;
let noticeTimer = 0;
const touch = new TouchControls(document.getElementById('touch-layer') as HTMLElement);
const audio = new AudioOutput();
const fastForward = new FastForward();
// Sound is dropped while fast-forwarding: the buffers would pile up faster than they play.
const sound = { push: (bytes: Uint8Array, hz: number) => { if (!fastForward.active) audio.push(bytes, hz); } };
addEventListener('keydown', (e) => fastForward.keydown(e));
addEventListener('keyup', (e) => fastForward.keyup(e));
addEventListener('blur', () => fastForward.reset());
// `?capture` hands the game's pace to `globalThis.ootStep(frames, x, y)`, which runs exactly that many frames with the stick held
// and then shows the last picture, so that two renders of the same scene (tools/tex/cutout-compare.ts) match frame for frame.
const captureMode = location.search.includes('capture');
if (captureMode) {
  (globalThis as { ootStep?: unknown }).ootStep = async (frames: number, x: number, y: number): Promise<void> => {
    if (!game) throw new Error('no game');
    const tasks = game.info().gfxTasks;
    for (let i = 0; i < frames || (game.info().gfxTasks === tasks && i < frames + 8); i++) {
      game.setPad({ buttons: 0, x, y });
      await game.frame();
    }
    renderer.present(game.framebuffer());
    edition.set(game.titleFade());
  };
}
let fps = 0;
let shownFps = 0;
let gameFps = 0;

// Browsers start sound only from a user gesture; a key press or click does it, and for touch only the release counts.
const enableSound = () => {
  audio.resume().catch((err) => console.error('sound is not available:', err));
};
addEventListener('keydown', enableSound);
addEventListener('pointerdown', enableSound);
addEventListener('pointerup', enableSound);
addEventListener('touchend', enableSound);
addEventListener('pointerup', enableSound);
addEventListener('touchend', enableSound);

const input = new Input(window, (text) => showNotice(text));
const showNotice = (text: string) => {
  notice.textContent = text;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => (notice.hidden = true), text.length > 30 ? 5000 : 2000);
};

const markFilled = (slot: number) => {
  const filled = [...store.get().filled];
  filled[slot - 1] = true;
  store.set({ filled });
};

/** Queues a save state action on the current slot. */
function stateAction(run: (s: SaveStates) => Promise<string>): void {
  if (!states) {
    showNotice('Save states are not available yet');
    return;
  }
  const target = states;
  bridge.queue.push(async () => {
    try {
      const message = await run(target);
      if (message.startsWith('Saved slot')) markFilled(target.slot);
      return message;
    } finally {
      store.set({ slot: target.slot });
    }
  }, 'Save state failed');
}

/** Queues a save file action. */
function saveAction(run: (target: SaveTarget) => Promise<string> | string): void {
  bridge.queue.push(() => {
    if (!game || !saves) throw new Error('the game is still starting');
    const g = game;
    return run({ game: g, saves, restarted: () => (autoStart = new AutoStart(() => fileSelectReached(guestRam(g.ram())))) });
  }, 'Could not load the save');
}

// 5 saves to the current slot, 6 loads it and 7 moves to the next slot.
const STATE_KEYS: Record<string, (s: SaveStates) => Promise<string>> = {
  '5': (s) => s.save(),
  '6': (s) => s.load(),
  '7': (s) => s.select(1),
};
addEventListener('keydown', (e) => {
  const action = STATE_KEYS[e.key];
  if (!action || e.ctrlKey || e.metaKey || e.altKey || isTyping(e)) return;
  e.preventDefault();
  if (e.repeat) return;
  stateAction(action);
});

const CULL_MODES: CullMode[] = ['normal', 'swapped', 'off'];
function toggleNative(): void {
  // Native 320x240, shown with hard pixels, for comparing with the console's resolution.
  const native = renderer.resolutionScale !== 1;
  renderer.setScale(native ? 1 : displayScale());
  canvas.classList.toggle('native', native);
  edition.canvas.classList.toggle('native', native);
  store.set({ native });
}
function cycleCull(): void {
  renderer.cullMode = CULL_MODES[(CULL_MODES.indexOf(renderer.cullMode) + 1) % CULL_MODES.length]!;
  store.set({ cull: renderer.cullMode });
}
function toggleMute(): void {
  store.set({ muted: audio.toggleMute() });
}

const stepStrength = (value: number, up: boolean): number => Math.min(100, Math.max(0, Math.round(value / 10) * 10 + (up ? 10 : -10)));
// P switches the lighting between per vertex and per pixel, Y the point lights at torches and fires. F cycles the texture filter, G switches multisampling, H the mip levels with anisotropic taps and V the cut-out edges. O, B and U switch the ambient
// occlusion, the bloom and the sharpening; [ and ] lower and raise the occlusion strength, , and . the bloom strength, - and = the sharpening strength,
// in steps of 10.
function changeGfx(change: Partial<GfxSettings>, text: string): void {
  gfx = { ...gfx, ...change };
  store.set({ ao: gfx.ao, aoStrength: gfx.aoStrength, bloom: gfx.bloom, bloomStrength: gfx.bloomStrength, bloomThreshold: gfx.bloomThreshold, bloomKnee: gfx.bloomKnee, bloomRadius: gfx.bloomRadius, sharpen: gfx.sharpen, sharpenStrength: gfx.sharpenStrength, lightingMode: gfx.lightingMode, pointLights: gfx.pointLights, pointLightStrength: gfx.pointLightStrength });
  renderer.setSettings(gfx);
  if (!saveSettings(gfx)) showNotice('The browser did not keep the graphics settings');
  else showNotice(text);
}
addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e)) return;
  if (e.key === 'f' || e.key === 'F') {
    const filter = FILTER_MODES[(FILTER_MODES.indexOf(gfx.filter) + 1) % FILTER_MODES.length]!;
    changeGfx({ filter }, `Texture filter: ${filter}`);
  } else if (e.key === 'g' || e.key === 'G') {
    changeGfx({ msaa: !gfx.msaa }, `Multisampling: ${gfx.msaa ? 'off' : 'on'}`);
  } else if (e.key === 'v' || e.key === 'V') {
    const cutout = gfx.cutout === 'smooth' ? 'hard' : 'smooth';
    changeGfx({ cutout }, `Cut-out edges: ${cutout}${cutout === 'smooth' && !gfx.msaa ? ' (needs multisampling)' : ''}`);
  } else if (e.key === 'p' || e.key === 'P') {
    const lightingMode = gfx.lightingMode === 'pixel' ? 'vertex' : 'pixel';
    changeGfx({ lightingMode }, `Lighting: ${lightingMode}`);
  } else if (e.key === 'y' || e.key === 'Y') {
    changeGfx({ pointLights: !gfx.pointLights }, `Point lights: ${gfx.pointLights ? 'off' : `on, ${gfx.pointLightStrength}`}`);
  } else if (e.key === 'h' || e.key === 'H') {
    changeGfx({ mipmaps: !gfx.mipmaps }, `Mip levels: ${gfx.mipmaps ? 'off' : 'on'}`);
  } else if (e.key === 'o' || e.key === 'O') {
    changeGfx({ ao: !gfx.ao }, `Ambient occlusion: ${gfx.ao ? 'off' : `on, ${gfx.aoStrength}`}`);
  } else if (e.key === '[' || e.key === ']') {
    const aoStrength = stepStrength(gfx.aoStrength, e.key === ']');
    changeGfx({ ao: true, aoStrength }, `Ambient occlusion strength: ${aoStrength}`);
  } else if (e.key === 'b' || e.key === 'B') {
    changeGfx({ bloom: !gfx.bloom }, `Bloom: ${gfx.bloom ? 'off' : `on, ${gfx.bloomStrength}`}`);
  } else if (e.key === 'u' || e.key === 'U') {
    changeGfx({ sharpen: !gfx.sharpen }, `Sharpening: ${gfx.sharpen ? 'off' : `on, ${gfx.sharpenStrength}`}`);
  } else if (e.key === ',' || e.key === '.') {
    const bloomStrength = stepStrength(gfx.bloomStrength, e.key === '.');
    changeGfx({ bloom: true, bloomStrength }, `Bloom strength: ${bloomStrength}`);
  } else if (e.key === '-' || e.key === '=') {
    const sharpenStrength = stepStrength(gfx.sharpenStrength, e.key === '=');
    changeGfx({ sharpen: true, sharpenStrength }, `Sharpening strength: ${sharpenStrength}`);
  }
});
let resizeTimer = 0;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (renderer.resolutionScale !== 1 && Math.abs(displayScale() - renderer.resolutionScale) > 0.01) renderer.setScale(displayScale());
  }, 200);
});
addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e)) return;
  if (e.key === 'n' || e.key === 'N') toggleNative();
  else if (e.key === 'm' || e.key === 'M') toggleMute();
  else if (e.key === 'c' || e.key === 'C') cycleCull();
});

function smoothLines(): string[] {
  if (!store.get().smooth) return [];
  if (fastForward.active) return ['smooth: off while fast-forwarding'];
  const info = game?.smoothInfo();
  if (!info) return ['smooth: on, waiting for two game frames'];
  const share = info.threeD === 0 ? 100 : (info.matched / info.threeD) * 100;
  return [`smooth: on, ${info.matched} of ${info.threeD} 3D matrices matched (${share.toFixed(1)}%)${info.cut ? ', cut: drawn as is' : ''}, vertices written by the game ${(info.rewritten * 100).toFixed(1)}%`];
}

function updateWarp(): void {
  const s = store.get();
  if (!s.warpVisible) return;
  const next = snapshot(bridge);
  if (!sameSnapshot(s.warp, next)) store.set({ warp: next });
}

function updateInventory(): void {
  const s = store.get();
  if (!s.inventoryVisible) return;
  const next = inventorySnapshot(bridge);
  if (!sameInventory(s.inventory, next)) store.set({ inventory: next });
}

const MEMORY_REFRESH_MS = 100;
let memoryAt = 0;

// The Memory tab is read about ten times a second, so changed bytes stay visible long enough to see.
function updateMemory(now = performance.now(), force = false): void {
  if (!store.get().memoryVisible || (!force && now - memoryAt < MEMORY_REFRESH_MS)) return;
  memoryAt = now;
  store.set({ memory: memoryModel.tick(bridge) });
}

let actorsAt = 0;

function updateActors(now = performance.now()): void {
  const s = store.get();
  if (!s.actorsVisible || now - actorsAt < MEMORY_REFRESH_MS) return;
  actorsAt = now;
  const next = actorsSnapshot(bridge);
  if (!sameActors(s.actors, next)) store.set({ actors: next });
}

function updateOverlay(): void {
  updateWarp();
  updateActors();
  updateInventory();
  updateMemory();
  const showing = store.get().debugVisible;
  if (overlay.hidden && !showing) return;
  const s = renderer.stats;
  const g = game?.info();
  const text = [
    `${fps.toFixed(0)} fps (${bootHz} Hz mode)  game ${gameFps.toFixed(1)} frames/s  displayed ${shownFps.toFixed(0)} fps`,
    ...smoothLines(),
    ...timingLines(),
    g ? `frame ${g.frames}  retraces ${g.retraces}  gfx tasks ${g.gfxTasks}${g.idle ? '  IDLE' : ''}` : 'no game',
    `last task: ${s.commands} commands, ${s.batches} batches, ${s.triangles} triangles, ${s.rects} rects`,
    ...(game ? formatBreakdown(game.profiler.breakdown()) : []),
    `unknown commands ${s.unknown}  problems ${s.problems.length}`,
    `programs ${s.programs} (${s.compileMs.toFixed(0)} ms to build)  textures ${s.textures}  colour images ${s.targets}`,
    `mip programs: ${s.mipFallbackDraws} draws without them in the last task, ${s.programSwitches} variants switched on, ${s.mipFailures} failed  texture uploads (one mip build each): ${s.uploads} in the last task, ${s.totalUploads} in all, ${s.reuploads} of a picture seen before, most of one picture ${s.maxUploadsOfOne}`,
    game ? `video framebuffer 0x${game.framebuffer().toString(16)}` : '',
    `culling ${renderer.cullMode}  resolution ${renderer.resolutionScale.toFixed(2)}x (${canvas.width}x${canvas.height})  filter ${gfx.filter}  lighting ${gfx.lightingMode}  point lights ${gfx.pointLights ? gfx.pointLightStrength : 'off'}  msaa ${renderer.msaaSamples || 'off'}  ao ${gfx.ao ? gfx.aoStrength : 'off'}  bloom ${gfx.bloom ? gfx.bloomStrength : 'off'}  sharpen ${gfx.sharpen ? gfx.sharpenStrength : 'off'}  mips ${gfx.mipmaps ? `on, ${gfx.anisotropy} taps` : 'off'}  cutout ${renderer.msaaSamples ? gfx.cutout : 'hard'}`,
    g ? `audio tasks ${g.audioTasks}  sound ${audio.state === 'running' ? `on, level ${audio.level().toFixed(3)}` : 'off: press a key'}` : '',
    ...audio.status(),
    g?.renderError ? `render error: ${g.renderError}` : '',
    g?.audioError ? `audio error: ${g.audioError}` : '',
    ...s.problems,
  ].filter(Boolean).join('\n');
  renderer.trackTextureBuilds = !overlay.hidden;
  if (!overlay.hidden) overlay.textContent = text;
  if (showing) store.set({ debugText: text });
}

async function loop(): Promise<void> {
  let last = performance.now();
  const pacer = new FramePacer(bootHz);
  let countedGfx = game?.info().gfxTasks ?? 0;
  let counted = 0;
  let presented = 0;
  let countStart = last;
  while (game) {
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    if (bridge.queue.pending > 0) {
      for (const message of await bridge.queue.drain()) showNotice(message);
      last = performance.now();
    }
    // Fast-forward runs frames back to back and has no time for in-between pictures.
    game?.setSmooth(store.get().smooth && !fastForward.active);
    const now = performance.now();
    let due = captureMode ? 0 : pacer.advance(now - last);
    last = now;
    let stepped = false;
    // Fast-forward: frames back to back for most of the display interval.
    const budgetEnd = now + FAST_BUDGET_MS;
    while (game && (fastForward.active ? !stepped || performance.now() < budgetEnd : due > 0)) {
      if (fastForward.active) pacer.reset();
      else due--;
      try {
        bridge.applyFreezes();
        const pad = mergePads(input.poll(), store.get().sheetOpen ? { buttons: 0, x: 0, y: 0 } : touch.poll());
        if (autoStart) {
          pad.buttons |= autoStart.buttons();
          if (!autoStart.active) autoStart = null;
        }
        game.setPad(pad);
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
    if (game && !captureMode) {
      const smooth = game.drawSmooth(pacer.fraction());
      if (smooth !== null || stepped) {
        renderer.present(smooth ?? game.framebuffer());
        edition.set(game.titleFade());
        mark('firstFrame');
        presented++;
      }
    }
    if (now - countStart >= 1000) {
      fps = (counted * 1000) / (now - countStart);
      shownFps = (presented * 1000) / (now - countStart);
      presented = 0;
      const gfxTasks = game?.info().gfxTasks ?? countedGfx;
      gameFps = ((gfxTasks - countedGfx) * 1000) / (now - countStart);
      countedGfx = gfxTasks;
      counted = 0;
      countStart = now;
    }
    updateOverlay();
  }
  updateOverlay();
}

async function boot(): Promise<void> {
  try {
    // The slow path shows progress as bytes; a load under SLOW_LOAD_MS shows the one short status only.
    const loadStart = performance.now();
    const cartridge = loadCartridge((bytes, total) => {
      if (total > 0 && performance.now() - loadStart > SLOW_LOAD_MS) setStatus(`Loading: ${(bytes / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB`);
    });
    const [onServer, rom] = await Promise.all([import.meta.env.MODE === 'pages' ? false : serverHasSaves(), cartridge, wasm.module]);
    const started = await startGame(rom, renderer, sound, wasm, undefined, bootHz);
    if (onServer) {
      const moved = await migrateToServer(
        { sram: indexedDbStore(), states: indexedDbStates() },
        { sram: serverStore(), states: serverStates() },
        (what, err) => console.error(`could not move ${what} to the saves folder:`, err),
      );
      if (moved.length > 0) showNotice(`Moved saves to the saves folder: ${moved.join(', ')}`);
    }
    // The Pages site has no saves server: it carries the player's saves as files and a new visitor starts from them.
    const base = import.meta.env.BASE_URL;
    const published = import.meta.env.MODE !== 'pages' ? null : await loadPublished(base);
    const sramStore = onServer ? serverStore() : published ? withPublishedSram(indexedDbStore(), published, base) : indexedDbStore();
    const stateStore = onServer ? serverStates() : published ? withPublishedStates(indexedDbStates(), published, base) : indexedDbStates();
    const sync = new SaveSync(started.saveMemory, sramStore);
    await sync.restore();
    saves = sync;
    try {
      states = new SaveStates(started.states, stateStore, STATE_VERSION, bootHz);
    } catch (err) {
      console.error('save states are not available:', err);
    }
    game = started;
    store.set({ slot: states?.slot ?? null, muted: audio.isMuted });
    applyTuning();
    setStatus('Running');
    void loop();
    if (!captureMode) void applyBootParams(parseBootParams(location.search));
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
  }
}

/** Runs `run` between two frames and resolves with the message it gives, or the failure. */
function betweenFrames(run: () => Promise<string> | string): Promise<string> {
  return new Promise((resolve) => {
    bridge.queue.push(async () => {
      try {
        const message = await run();
        resolve(message);
        return message;
      } catch (err) {
        const message = `Failed: ${err instanceof Error ? err.message : String(err)}`;
        resolve(message);
        return message;
      }
    });
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const BOOT_WAIT_MS = 60_000;

/** Waits until the game can be changed between frames; false when it did not within BOOT_WAIT_MS. */
async function untilSettled(): Promise<boolean> {
  for (let waited = 0; waited < BOOT_WAIT_MS; waited += 100) {
    if (!bridge.unsafeReason()) return true;
    await sleep(100);
  }
  return false;
}

const SETTLE_FRAMES = 1500;

/** Runs frames back to back, with no input and no picture, until `done` holds; false when it does not within SETTLE_FRAMES. */
async function runUntil(g: Game, done: () => boolean): Promise<boolean> {
  g.setPad({ buttons: 0, x: 0, y: 0 });
  for (let i = 0; i < SETTLE_FRAMES && !done(); i++) await g.frame();
  return done();
}

/** Puts a record of the save memory in play without the title or the file select: runs to the title's demo scene, loads the record into the save context there and runs until the scene is settled. */
async function enterFile(g: Game, record: Uint8Array, slot: number): Promise<string> {
  const mem = () => guestRam(g.ram());
  if (!(await runUntil(g, () => playState((a) => mem().rd32(a)) !== undefined))) return 'Could not enter the save file: the game did not reach a scene';
  const { scene } = loadRecordIntoPlay(mem(), record, slot, true);
  if (!(await runUntil(g, () => unsafeReason(mem()) === undefined))) return 'Could not enter the save file: the scene did not settle';
  return `Entered save file ${slot + 1} (scene ${scene})`;
}

/** Applies the URL parameters in order: save state, save file, warp. A parameter that cannot be applied is reported and the game keeps running. */
async function applyBootParams(params: BootParams): Promise<void> {
  const problems = [...params.problems];
  const report = () => {
    if (problems.length > 0) showNotice(problems.join('; '));
  };
  report();
  let entered = false;
  if (params.state !== undefined) {
    const slot = params.state;
    const target = states;
    if (!target) {
      problems.push('Save states are not available');
    } else {
      const message = await betweenFrames(async () => {
        await target.select(slot - target.slot);
        store.set({ slot: target.slot });
        return target.load();
      });
      showNotice(message);
      entered = message.startsWith('Loaded');
      if (!entered) problems.push(message);
    }
  }
  if (params.file !== undefined) {
    const file = params.file;
    const g = game;
    if (!g) return;
    const record = getRecord(g.saveMemory.read(), file - 1);
    if (!record) {
      problems.push(`Save file ${file} is empty`);
    } else {
      const message = await betweenFrames(() => enterFile(g, record, file - 1));
      showNotice(message);
      entered = message.startsWith('Entered');
      if (!entered) problems.push(message);
    }
  }
  if (params.warp !== undefined) {
    const entrance = params.warp;
    if ((params.state !== undefined || params.file !== undefined) && !entered) {
      problems.push(`Warp to ${entrance} skipped: no scene was entered`);
    } else if (!(await untilSettled())) {
      problems.push(`Warp to ${entrance} skipped: the game is not in a scene`);
    } else {
      bridge.queue.push(() => warpTo(bridge, entrance), 'Warp failed');
    }
  }
  report();
}

function setCheats(cheats: Cheat[]): void {
  store.set({ cheats });
  saveCheats(cheats);
  applyCheats(bridge.freezes, cheats);
}

const actions: UiActions = {
  setSmooth(on) {
    writeSmooth(on);
    store.set({ smooth: on });
  },
  setStrength(percent) {
    writeTuning(STRENGTH_KEY, percent);
    store.set({ strength: percent });
  },
  setSpan(percent) {
    writeTuning(SPAN_KEY, percent);
    store.set({ span: percent });
  },
  setAo: (ao) => changeGfx({ ao }, `Ambient occlusion: ${ao ? `on, ${gfx.aoStrength}` : 'off'}`),
  setAoStrength: (aoStrength) => changeGfx({ ao: true, aoStrength }, `Ambient occlusion strength: ${aoStrength}`),
  setBloom: (bloom) => changeGfx({ bloom }, `Bloom: ${bloom ? `on, ${gfx.bloomStrength}` : 'off'}`),
  setBloomStrength: (bloomStrength) => changeGfx({ bloom: true, bloomStrength }, `Bloom strength: ${bloomStrength}`),
  setBloomThreshold: (bloomThreshold) => changeGfx({ bloom: true, bloomThreshold }, `Bloom threshold: ${bloomThreshold}`),
  setBloomKnee: (bloomKnee) => changeGfx({ bloom: true, bloomKnee }, `Bloom soft knee: ${bloomKnee}`),
  setBloomRadius: (bloomRadius) => changeGfx({ bloom: true, bloomRadius }, `Bloom radius: ${bloomRadius}`),
  setLightingMode: (lightingMode) => changeGfx({ lightingMode }, `Lighting: ${lightingMode}`),
  setPointLights: (pointLights) => changeGfx({ pointLights }, `Point lights: ${pointLights ? `on, ${gfx.pointLightStrength}` : 'off'}`),
  setPointLightStrength: (pointLightStrength) => changeGfx({ pointLights: true, pointLightStrength }, `Point light strength: ${pointLightStrength}`),
  setSharpen: (sharpen) => changeGfx({ sharpen }, `Sharpening: ${sharpen ? `on, ${gfx.sharpenStrength}` : 'off'}`),
  setSharpenStrength: (sharpenStrength) => changeGfx({ sharpen: true, sharpenStrength }, `Sharpening strength: ${sharpenStrength}`),
  toggleHz() {
    const wantedHz: Hz = store.get().wantedHz === 60 ? 50 : 60;
    if (!saveHz(wantedHz)) showNotice('The browser did not keep the 60 Hz choice');
    store.set({ wantedHz });
  },
  toggleMute,
  toggleNative,
  cycleCull,
  toggleControls: () => store.set({ controlsHidden: touch.toggleHidden() }),
  toggleFullscreen,
  padView: () => input.view(),
  setOverlay(on) {
    overlay.hidden = !on;
    store.set({ overlayShown: on });
  },
  saveSlot: (slot) => stateAction(async (s) => {
    await s.select(slot - s.slot);
    return s.save();
  }),
  loadSlot: (slot) => stateAction(async (s) => {
    await s.select(slot - s.slot);
    return s.load();
  }),
  selectSlot: (slot) => stateAction((s) => s.select(slot - s.slot)),
  refreshSlots() {
    states?.filled().then((filled) => store.set({ filled }), (err) => console.error('could not list the save states:', err));
  },
  loadSaveFile() {
    pickSaveFile().then(
      (bytes) => {
        if (bytes) saveAction((target) => loadSaveFile(target, bytes));
      },
      (err) => showNotice(err instanceof Error ? err.message : String(err)),
    );
  },
  loadIntoPlay: (slot) => saveAction((target) => loadSlotIntoPlay(target, slot)),
  backToFileSelect: () => saveAction((target) => backToFileSelect(target)),
  entrances() {
    const mem = bridge.ram();
    return mem ? readEntrances(mem) : null;
  },
  warp: (entry) => bridge.queue.push(() => warpTo(bridge, entry), 'Warp failed'),
  editSave: (edits) => bridge.queue.push(() => editContext(bridge, edits), 'Edit failed'),
  toggleFreeze: (key) => bridge.queue.push(() => toggleFreeze(bridge, key), 'Hold failed'),
  gotoMemory(text) {
    try {
      memoryModel.setStart(parseAddress(text));
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    updateMemory(performance.now(), true);
  },
  pageMemory(bytes) {
    memoryModel.setStart(memoryModel.windowStart + bytes);
    updateMemory(performance.now(), true);
  },
  writeMemory: (addr, type, text) => bridge.queue.push(() => memoryModel.write(bridge, addr, type, text), 'Write failed'),
  addWatch(addr, type) {
    try {
      memoryModel.addWatch(parseAddress(addr), type);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    updateMemory(performance.now(), true);
  },
  removeWatch(id) {
    memoryModel.removeWatch(bridge, id);
    updateMemory(performance.now(), true);
  },
  holdWatch: (id) => bridge.queue.push(() => memoryModel.toggleHold(bridge, id), 'Hold failed'),
  writeWatch: (id, text) => bridge.queue.push(() => memoryModel.writeWatch(bridge, id, text), 'Write failed'),
  searchStart: (type) => bridge.queue.push(() => memoryModel.startSearch(bridge, type), 'Search failed'),
  searchNarrow: (kind, value) => bridge.queue.push(() => memoryModel.narrow(bridge, kind, value), 'Search failed'),
  searchEnd() {
    memoryModel.endSearch();
    updateMemory(performance.now(), true);
  },
  addCheat(name, code) {
    const parsed = parseCode(code);
    if ('error' in parsed) return parsed.error;
    setCheats([...store.get().cheats, { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: name.trim(), code: code.trim(), enabled: true }]);
  },
  toggleCheat: (id) => setCheats(store.get().cheats.map((c) => (c.id === id ? { ...c, enabled: !c.enabled } : c))),
  removeCheat: (id) => setCheats(store.get().cheats.filter((c) => c.id !== id)),
  toggleLightActor(id) {
    const lightIds = toggleId(store.get().lightIds, id);
    saveLightIds(lightIds);
    renderer.markedLightIds = new Set(lightIds);
    store.set({ lightIds });
    showNotice(lightIds.includes(id) ? `Actors with id 0x${id.toString(16)} light up (point lights must be on)` : `Actors with id 0x${id.toString(16)} no longer light up`);
  },
  goToActor: (addr) => bridge.queue.push(() => goToActor(bridge, addr, (id) => labels.get('actor', id) ?? `actor ${id}`), 'Go to failed'),
  viewRecord(addr) {
    memoryModel.setStart(addr);
    updateMemory(performance.now(), true);
    store.set({ tabRequest: 'memory' });
  },
};
// Touch input stops while the menu sheet covers the picture.
store.subscribe(() => {
  if (store.get().sheetOpen) touch.pad.reset();
});
mountUi(document.getElementById('ui-root') as HTMLElement, store, actions);

void boot();
