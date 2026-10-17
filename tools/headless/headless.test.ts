import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadContext } from '../analyze/context.ts';
import { AudioCapture } from '../audio/capture.ts';
import { RspReference } from '../audio/rsp-ref.ts';
import { Synth } from '../audio/synth.ts';
import { encodeWav } from '../audio/wav.ts';
import { DisplayListInterpreter, type Batch, type DisplayListResult } from '../gfx/dl.ts';
import { HEIGHT, SoftRenderer, WIDTH } from '../gfx/raster.ts';
import { bootGame } from './boot.ts';
import { padAt } from './input.ts';
import { FILE_SELECT_INIT_LINKED, FILE_SELECT_RECORD, RECORD, fileSelectLoaded, linkPosition, playState } from './state.ts';
import { rom, FRAMES, CONFIRM_FRAME, SCRIPT, DRAW_LEAD, TITLE_FRAME, FILE_LIST_FRAME, SAVED_BY_FRAME, NARRATION_FRAME, CASTLE_FRAME, FOREST_FRAME, HOUSE_CUTSCENE_FRAME, CONTROL_FRAME, WALKED_FORWARD_FRAME, WALKED_RIGHT_FRAME, HOUSE_SCENE, BACKGROUND_ADDRESS, BACKGROUND_SHA256, TITLE_AUDIO_FRAMES, COMPARE_FRAMES, buildGame, bootCapturing, differingPixels, nonFlatPixels, dump } from './headless-support.ts';

describe.skipIf(!rom || !existsSync(rom))('headless boot', () => {
  it('boots 300 video frames with the retrace and a graphics task going on and no trap', async () => {
    const { moduleUrl, cartridge } = await buildGame();
    const game = await bootGame(moduleUrl, cartridge);
    const gfxAt: number[] = [];
    let gfx = 0;
    let threads = 0;
    for (let k = 1; k <= FRAMES; k++) {
      const r = await game.frame();
      expect(r.fatal, `frame ${k}`).toBeUndefined();
      expect(r.alive, `frame ${k}`).toBe(true);
      // The retrace of a frame is counted when it ends; the first one comes with the first full interval.
      expect(r.retraces, `frame ${k}`).toBeGreaterThanOrEqual(k - 1);
      if (r.gfxTasks > gfx) gfxAt.push(k);
      gfx = r.gfxTasks;
      threads += r.newThreads.length;
    }

    expect(gfxAt.length).toBeGreaterThan(150);
    expect(gfxAt[0]).toBeLessThan(60);
    // After the first one the game submits a graphics task every frame, then every third frame once it paces itself
    // at three retraces; the switch between the two modes takes one longer frame.
    for (let k = 1; k < gfxAt.length; k++) expect(gfxAt[k]! - gfxAt[k - 1]!, `gap before frame ${gfxAt[k]}`).toBeLessThanOrEqual(6);
    expect(gfxAt[gfxAt.length - 1]).toBeGreaterThan(FRAMES - 4);
    expect(threads).toBeGreaterThanOrEqual(8);
  }, 3_600_000);

  it('reaches the file selection when Start is pressed at the title, and keeps a new file in the save memory', async () => {
    const ctx = loadContext(rom!);
    const file33 = ctx.files.find((f) => f.index === 33)!;
    const first = await bootCapturing(new Set([TITLE_FRAME, FILE_LIST_FRAME]));

    await first.play(TITLE_FRAME);
    const rd = (addr: number) => first.game.rd32(addr);
    // The game's own record of the file select overlay (its file is 33 of the file table) still holds the link address.
    expect(rd(FILE_SELECT_RECORD + RECORD.romStart) >>> 0).toBe(file33.virtualStart);
    expect(rd(FILE_SELECT_RECORD + RECORD.romEnd) >>> 0).toBe(file33.virtualEnd);
    expect(rd(FILE_SELECT_RECORD + RECORD.init) >>> 0).toBe(FILE_SELECT_INIT_LINKED);
    expect(fileSelectLoaded(rd)).toBe(false);

    await first.play(FILE_LIST_FRAME);
    // The loader rewrote the record: the init routine's link address became its address in the loaded overlay.
    const init = rd(FILE_SELECT_RECORD + RECORD.init) >>> 0;
    expect(fileSelectLoaded(rd)).toBe(true);
    const linkStart = rd(FILE_SELECT_RECORD + RECORD.linkStart) >>> 0;
    const loadedAt = (init - (FILE_SELECT_INIT_LINKED - linkStart)) >>> 0;
    expect(loadedAt).toBeGreaterThanOrEqual(0x80000000);
    expect(loadedAt + (rd(FILE_SELECT_RECORD + RECORD.linkEnd) - linkStart)).toBeLessThan(0x80800000);

    const title = first.shots.get(TITLE_FRAME)!;
    const emptyList = first.shots.get(FILE_LIST_FRAME)!;
    dump('title', title);
    dump('file-select', emptyList);
    expect(differingPixels(title, emptyList)).toBeGreaterThan(WIDTH * HEIGHT * 0.1);

    // Writes before the file is confirmed (the game sets up the save memory while it boots) do not count.
    await first.play(CONFIRM_FRAME - 1);
    first.game.takeSaveDirty();
    await first.play(SAVED_BY_FRAME);
    expect(first.game.takeSaveDirty()).toBe(true);
    const saved = first.game.readSave();
    expect(saved.some((b) => b !== 0)).toBe(true);

    // A fresh boot with that save memory lists the file instead of an empty slot.
    const second = await bootCapturing(new Set([FILE_LIST_FRAME]));
    second.game.writeSave(saved);
    await second.play(FILE_LIST_FRAME);
    const restoredList = second.shots.get(FILE_LIST_FRAME)!;
    dump('file-select-restored', restoredList);
    expect(differingPixels(emptyList, restoredList)).toBeGreaterThan(200);
  }, 3_600_000);

  it('plays a new game from file creation to a Link who walks when the stick moves, with no trap', async () => {
    const shots = new Set([NARRATION_FRAME, CASTLE_FRAME, FOREST_FRAME, HOUSE_CUTSCENE_FRAME, CONTROL_FRAME]);
    const run = await bootCapturing(shots);
    const rd = (addr: number) => run.game.rd32(addr);
    const sceneAt = async (frame: number) => {
      await run.play(frame);
      return playState(rd);
    };

    // Starting the game submits the JPEG decode task (type 4 with the microcode at 0x800E4B10) for Link's house background.
    expect((await sceneAt(NARRATION_FRAME))?.scene).toBe(HOUSE_SCENE);
    expect(run.jpegTasks()).toBeGreaterThan(0);
    const castle = (await sceneAt(CASTLE_FRAME))?.scene;
    const forest = (await sceneAt(FOREST_FRAME))?.scene;
    expect(castle).toBeDefined();
    expect(forest).toBeDefined();
    expect(new Set([HOUSE_SCENE, castle, forest]).size).toBe(3);
    expect((await sceneAt(HOUSE_CUTSCENE_FRAME))?.scene).toBe(HOUSE_SCENE);

    // 300 macroblocks of 16x16 pixels make the background: 320x240 halfwords, checked against the digest of the decoded treehouse picture.
    const at = BACKGROUND_ADDRESS & 0x7fffff;
    const digest = createHash('sha256').update(run.game.ram().subarray(at, at + 320 * 240 * 2)).digest('hex');
    expect(digest).toBe(BACKGROUND_SHA256);

    // Idle before the stick moves, then forward, then right: the position changes with the stick and in no other frame.
    await run.play(CONTROL_FRAME - 10);
    const play = playState(rd);
    expect(play?.scene).toBe(HOUSE_SCENE);
    const before = linkPosition(rd, play!);
    expect(before).toBeDefined();
    await run.play(CONTROL_FRAME);
    const idle = linkPosition(rd, play!)!;
    expect(idle).toEqual(before);
    await run.play(WALKED_FORWARD_FRAME);
    const forward = linkPosition(rd, play!)!;
    expect(Math.hypot(forward.x - idle.x, forward.z - idle.z)).toBeGreaterThan(10);
    expect(forward.y).toBeCloseTo(idle.y, 1);
    await run.play(WALKED_RIGHT_FRAME);
    const right = linkPosition(rd, play!)!;
    expect(Math.hypot(right.x - forward.x, right.z - forward.z)).toBeGreaterThan(10);
    // He slides to a stop after the stick is released.
    await run.play(WALKED_RIGHT_FRAME + 60);
    const stopped = linkPosition(rd, play!)!;
    await run.play(WALKED_RIGHT_FRAME + 120);
    expect(linkPosition(rd, play!)).toEqual(stopped);

    const images = [NARRATION_FRAME, CASTLE_FRAME, FOREST_FRAME, HOUSE_CUTSCENE_FRAME, CONTROL_FRAME].map((f) => {
      const img = run.shots.get(f)!;
      dump(`new-game-${f}`, img);
      expect(nonFlatPixels(img), `frame ${f} is not blank`).toBeGreaterThan(300);
      return img;
    });
    for (let a = 0; a < images.length; a++)
      for (let b = a + 1; b < images.length; b++) expect(differingPixels(images[a]!, images[b]!), `frames ${a} and ${b} differ`).toBeGreaterThan(300);

    // The house is drawn with no unknown command and no interpreter problem, and the room's picture is on screen: most pixels
    // of the frame under control are the decoded picture's, the rest being Link, the objects and the HUD in front of it.
    expect(run.unknown).toEqual([]);
    const picture = run.game.ram().subarray(at, at + 320 * 240 * 2);
    const shot = run.shots.get(CONTROL_FRAME)!;
    let same = 0;
    for (let i = 0; i < 320 * 240; i++) {
      const px = (picture[i * 2]! << 8) | picture[i * 2 + 1]!;
      const [r, g, b] = [(px >>> 11) & 31, (px >>> 6) & 31, (px >>> 1) & 31].map((c) => (c << 3) | (c >> 2));
      if (shot[i * 4] === r && shot[i * 4 + 1] === g && shot[i * 4 + 2] === b) same++;
    }
    expect(same / (320 * 240)).toBeGreaterThan(0.85);
  }, 3_600_000);

  it('renders the title music to a WAV that is audible and not clipped', async () => {
    const { moduleUrl, cartridge } = await buildGame();
    const audio = new AudioCapture();
    const game = await bootGame(moduleUrl, cartridge, audio.hooks);
    let titleStart = 0;
    for (let k = 1; k <= TITLE_FRAME + TITLE_AUDIO_FRAMES; k++) {
      const r = await game.frame();
      expect(r.fatal, `frame ${k}`).toBeUndefined();
      if (k === TITLE_FRAME) titleStart = audio.samples().length;
    }
    expect(audio.error).toBeUndefined();
    expect(audio.hz).toBeGreaterThan(30000);
    expect(audio.hz).toBeLessThan(34000);
    const title = audio.samples().subarray(titleStart);
    const dir = resolve('out', 'audio');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'title.wav'), encodeWav(title, 2, audio.hz));

    // 50 frames of audio per second: the game queues one buffer per frame.
    expect(title.length / 2 / audio.hz).toBeGreaterThan(TITLE_AUDIO_FRAMES / 50 - 0.2);
    let peak = 0, sum = 0, clipped = 0;
    for (const x of title) {
      peak = Math.max(peak, Math.abs(x));
      sum += x * x;
      if (x >= 32767 || x <= -32768) clipped++;
    }
    const rms = Math.sqrt(sum / title.length);
    expect(rms, 'not silent').toBeGreaterThan(300);
    expect(peak, 'has a peak').toBeGreaterThan(3000);
    expect(clipped / title.length, 'not clipped').toBeLessThan(0.0005);
    // Sound all the way through, not one burst: every half second holds signal.
    const window = Math.floor(audio.hz / 2) * 2;
    for (let at = 0; at + window <= title.length; at += window) {
      let e = 0;
      for (let i = at; i < at + window; i++) e += title[i]! * title[i]!;
      expect(Math.sqrt(e / window), `half second at ${at / window}`).toBeGreaterThan(50);
    }
  }, 3_600_000);

  it('mixes the same samples as the audio microcode does on the commands of the intro, the title and the file select', async () => {
    const { moduleUrl, cartridge } = await buildGame();
    const synth = new Synth();
    let frame = 0;
    let compared = 0;
    const pending = [...COMPARE_FRAMES];
    const problems: string[] = [];
    const game = await bootGame(moduleUrl, cartridge, {
      onAudioTask: (t) => {
        const task = { list: t.data & 0x1fffffff, size: t.size, dataSegment: t.microcodeData & 0x1fffffff };
        if (pending.length === 0 || frame < pending[0]!) {
          synth.run(t.ram, task);
          return;
        }
        pending.shift();
        // The reference starts from the working memory the mixer holds, which is what the console's processor would still
        // hold from the previous task, and runs on a copy of the memory the mixer is about to change.
        const code = t.ram.subarray(t.microcode & 0x1fffffff, (t.microcode & 0x1fffffff) + 0x1000);
        const expected = t.ram.slice();
        const reference = new RspReference(code);
        reference.dmem.set(synth.dmem);
        synth.run(t.ram, task);
        reference.run(expected, { dataPtr: task.dataSegment, dataSize: 0x2df, listPtr: task.list, listSize: task.size });
        compared++;
        let differing = 0;
        for (let i = 0; i < expected.length; i++) if (expected[i] !== t.ram[i]) differing++;
        if (differing > 0) problems.push(`frame ${frame}: ${differing} bytes differ`);
      },
    });
    while (frame < COMPARE_FRAMES[COMPARE_FRAMES.length - 1]! + 5) {
      frame++;
      const pad = padAt(SCRIPT, frame);
      game.setPad(pad.buttons, pad.x, pad.y);
      const r = await game.frame();
      expect(r.fatal, `frame ${frame}`).toBeUndefined();
    }
    expect(compared).toBe(COMPARE_FRAMES.length);
    expect(problems).toEqual([]);
  }, 3_600_000);

  describe('alpha, depth and blending of the drawn frames', () => {
    /** The graphics tasks of the last frames before `target`, and the colour image the video interface shows then. */
    const capture = async (target: number) => {
      const { moduleUrl, cartridge } = await buildGame();
      const interpreter = new DisplayListInterpreter();
      const results: DisplayListResult[] = [];
      let frame = 0;
      const game = await bootGame(moduleUrl, cartridge, {
        onGfxTask: (task) => {
          if (frame > target - DRAW_LEAD) results.push(interpreter.run(task.ram, task.data));
        },
      });
      while (frame < target) {
        frame++;
        const pad = padAt(SCRIPT, frame);
        game.setPad(pad.buttons, pad.x, pad.y);
        expect((await game.frame()).fatal, `frame ${frame}`).toBeUndefined();
      }
      const render = (keep: (b: Batch) => boolean) => {
        const soft = new SoftRenderer();
        for (const r of results) soft.drawTask({ ...r, batches: r.batches.filter(keep) });
        return soft.image(game.framebuffer())!;
      };
      return { results, render };
    };
    const CVG_TIMES_ALPHA = 1 << 12;
    const luminance = (img: Uint8Array, i: number) => img[i]! + img[i + 1]! + img[i + 2]!;

    it("leaves out the transparent texels of the forest's cutout textures", async () => {
      const { results } = await capture(FOREST_FRAME - 200);
      let tested = 0;
      for (const r of results) for (const b of r.batches) {
        const texture = b.state.textures[0];
        if (b.kind !== 'triangles' || !(b.state.otherModeL & CVG_TIMES_ALPHA) || !texture) continue;
        let clear = 0;
        for (let i = 3; i < texture.rgba.length; i += 4) if (texture.rgba[i]! < 32) clear++;
        if (clear === 0 || clear === texture.width * texture.height) continue;
        const cut = new SoftRenderer();
        cut.drawTask({ ...r, batches: [b] });
        const solid = new SoftRenderer();
        solid.drawTask({ ...r, batches: [{ ...b, state: { ...b.state, otherModeL: b.state.otherModeL & ~CVG_TIMES_ALPHA } }] });
        expect(cut.pixelsWritten).toBeLessThanOrEqual(solid.pixelsWritten);
        if (cut.pixelsWritten < solid.pixelsWritten) tested++;
      }
      expect(tested).toBeGreaterThan(20);
    }, 3_600_000);

    it('draws the three hearts of a new file and a shadow that only darkens the ground', async () => {
      const { render } = await capture(CONTROL_FRAME + 50);
      const frame = render(() => true);
      // The third heart is the beating one: a textured quad at z / w = -1.4, in front of the near plane.
      for (const [from, to] of [[24, 36], [36, 46], [46, 60]] as const) {
        let red = 0;
        for (let y = 14; y < 36; y++) {
          for (let x = from; x < to; x++) {
            const o = (y * WIDTH + x) * 4;
            if (frame[o]! > 180 && frame[o + 1]! < 110 && frame[o + 2]! < 110) red++;
          }
        }
        expect(red, `heart between x = ${from} and ${to}`).toBeGreaterThan(15);
      }

      // The decal draws (depth mode 3) are the shadow: without them no pixel is darker, with them none is lighter.
      const decal = (b: Batch) => b.kind === 'triangles' && ((b.state.otherModeL >>> 10) & 3) === 3;
      const bare = render((b) => !decal(b));
      let darker = 0;
      for (let i = 0; i < frame.length; i += 4) {
        const d = luminance(frame, i) - luminance(bare, i);
        expect(d, `pixel ${i / 4}`).toBeLessThanOrEqual(0);
        if (d < 0) darker++;
      }
      expect(darker).toBeGreaterThan(50);
    }, 3_600_000);
  });
});
