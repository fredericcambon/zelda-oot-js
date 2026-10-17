// `npm run headless -- --frames N [--trace] [--wav out.wav] [--profile]`: boots the built game (dist/oot.js) from dist/assets in Node with no
// display and reports what it did frame by frame.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readCartridge } from '../assets/write.ts';
import { AudioCapture } from '../audio/capture.ts';
import { encodeWav } from '../audio/wav.ts';
import { DisplayListInterpreter } from '../gfx/dl.ts';
import { encodePng } from '../gfx/png.ts';
import { HEIGHT, SoftRenderer, WIDTH } from '../gfx/raster.ts';
import { drawCallsOf, formatBreakdown, FrameProfiler, WINDOW } from '../gfx/profile.ts';
import { DlTotals } from '../gfx/totals.ts';
import { bootGame, type AiBuffer, type AudioTask, type Game } from './boot.ts';
import { padAt, parseInput } from './input.ts';
import { playState, requestEntrance } from './state.ts';

/** Frames drawn before a dumped frame, so that its colour image is complete. */
const DRAW_LEAD = 8;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      rom: { type: 'string' },
      dist: { type: 'string', default: 'dist' },
      frames: { type: 'string', default: '300' },
      trace: { type: 'boolean', default: false },
      dl: { type: 'boolean', default: false },
      dump: { type: 'string' },
      wav: { type: 'string' },
      'dump-every': { type: 'string', default: '1' },
      'dump-from': { type: 'string', default: '0' },
      'dump-at': { type: 'string' },
      input: { type: 'string' },
      entrance: { type: 'string' },
      'entrance-at': { type: 'string', default: '19000' },
      profile: { type: 'boolean', default: false },
      'profile-window': { type: 'string', default: String(WINDOW) },
    },
  });
  const frames = Number(values.frames);
  // The game runs from the assets `npm run port` wrote; a ROM file is only for comparing against them.
  const rom = values.rom ? readFileSync(values.rom) : readCartridge(join(resolve(values.dist!), 'assets'));
  const interpreter = new DisplayListInterpreter();
  const totals = new DlTotals();
  const soft = values.dump ? new SoftRenderer() : undefined;
  const dumpDir = values.dump ? resolve(values.dump) : undefined;
  if (dumpDir) mkdirSync(dumpDir, { recursive: true });
  const profiler = values.profile ? new FrameProfiler(undefined, Math.max(1, Number(values['profile-window']))) : undefined;
  const audio = values.wav ? new AudioCapture() : undefined;
  const dumpEvery = Math.max(1, Number(values['dump-every']));
  // Frames before this one are not drawn: each frame is redrawn whole, so only the speed changes.
  const dumpFrom = Number(values['dump-from']);
  // With --dump-at only the listed frames are dumped and --dump-every and --dump-from are ignored.
  const dumpAt = (values['dump-at'] ?? '').split(',').filter(Boolean).map(Number);
  const script = values.input ? parseInput(readFileSync(values.input, 'utf8'), values.input) : { states: [], taps: [] };
  // With --entrance the game is made to load that entrance at frame --entrance-at (Link's house under control in the scripted
  // new game); the cutscene that follows is skipped with an A tap every 40 frames, as the sweep does.
  const entrance = values.entrance === undefined ? undefined : Number(values.entrance);
  const entranceAt = Number(values['entrance-at']);
  const afterEntrance = parseInput('tap A 100 4000 40 3', 'tap');
  let frameNo = 0;
  let game: Game;
  try {
    game = await bootGame(pathToFileURL(resolve(values.dist!, 'oot.js')).href, rom, {
      onGfxTask: values.dl || soft || profiler
        ? (task) => {
            const handle = () => {
              const t0 = performance.now();
              const result = interpreter.run(task.ram, task.data);
              profiler?.addDisplayList(performance.now() - t0);
              profiler?.addDrawCalls(drawCallsOf(result));
              profiler?.taskDone();
              if (values.dl) totals.add(result);
              const wanted = dumpAt.length > 0 ? dumpAt.some((f) => frameNo <= f && frameNo > f - DRAW_LEAD) : frameNo >= dumpFrom - 2;
              if (wanted) soft?.drawTask(result);
            };
            if (profiler) profiler.hook(handle);
            else handle();
          }
        : undefined,
      ...(profiler && audio
        ? {
            onAudioTask: (t: AudioTask) => profiler.hook(() => audio.hooks.onAudioTask(t)),
            onAiBuffer: (b: AiBuffer) => profiler.hook(() => audio.hooks.onAiBuffer(b)),
          }
        : audio?.hooks),
    });
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  for (let k = 0; k < frames; k++) {
    frameNo++;
    if (entrance !== undefined && frameNo === entranceAt + 1) {
      game.setPad(0, 0, 0);
      const ram = game.ram();
      const view = new DataView(ram.buffer, ram.byteOffset, ram.byteLength);
      const play = playState(game.rd32);
      if (!play) {
        console.error(`error: no play state at frame ${entranceAt} to load entrance ${entrance} into`);
        return 1;
      }
      requestEntrance(game.rd32, (addr, value) => view.setUint32(addr & 0x7fffff, value >>> 0), play, entrance);
    }
    const pad = entrance !== undefined && frameNo > entranceAt ? padAt(afterEntrance, frameNo - entranceAt) : padAt(script, frameNo);
    game.setPad(pad.buttons, pad.x, pad.y);
    const r = await (profiler ? profiler.frame(() => game.frame()) : game.frame());
    if (values.trace || r.newThreads.length > 0) {
      console.log(
        `frame ${r.frame}: retraces=${r.retraces} gfx=${r.gfxTasks} audio=${r.audioTasks}` +
          r.newThreads.map((t) => `\n  new thread ${t}`).join('') +
          (values.trace ? r.threadStates.map((t) => `\n  ${t}`).join('') : ''),
      );
    }
    if (r.fatal || !r.alive) {
      const calls = game.lastCalls(40);
      if (calls.length > 0) console.error(`last calls, newest first: ${calls.join(' ')}`);
    }
    const dumpNow = dumpAt.length > 0 ? dumpAt.includes(r.frame) : r.frame % dumpEvery === 0 && r.frame >= dumpFrom;
    if (soft && dumpDir && dumpNow) {
      const img = soft.image(game.framebuffer());
      if (img) writeFileSync(join(dumpDir, `frame-${String(r.frame).padStart(5, '0')}.png`), encodePng(WIDTH, HEIGHT, img));
    }
    if (r.fatal) {
      console.error(`trap at frame ${r.frame}: ${r.fatal}`);
      return 2;
    }
    if (!r.alive) {
      console.error(`nothing can run any more at frame ${r.frame}`);
      return 3;
    }
  }
  console.log(`booted ${frames} frames: ${game.stats()}`);
  if (audio && values.wav) {
    if (audio.error) console.error(`audio: ${audio.error.message}`);
    mkdirSync(resolve(values.wav, '..'), { recursive: true });
    writeFileSync(values.wav, encodeWav(audio.samples(), 2, audio.hz || 32000));
  }
  if (profiler) console.log(formatBreakdown(profiler.breakdown()).join('\n'));
  if (!values.dl) return 0;
  console.log(totals.summary());
  return totals.unknown.length > 0 ? 4 : 0;
}

process.exitCode = await main();
