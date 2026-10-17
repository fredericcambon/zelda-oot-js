import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { AudioCapture } from '../audio/capture.ts';
import { DisplayListInterpreter } from '../gfx/dl.ts';
import { bootGame } from './boot.ts';
import { averageSpectrum, envelope, playbackSpeed, similarity } from './spectrum.ts';
import { padAt } from './input.ts';
import { playState } from './state.ts';
import { rom, SCRIPT, FOREST_FRAME, WALKED_RIGHT_FRAME, HOUSE_SCENE, buildGame } from './headless-support.ts';

describe.skipIf(!rom || !existsSync(rom))('headless boot', () => {
  it('plays the new game in 60 Hz mode at 20 game frames per second with the sound of the 50 Hz mode', async () => {
    const { moduleUrl, cartridge } = await buildGame();
    const mono = (cap: AudioCapture) => {
      const s = cap.samples();
      return Float64Array.from({ length: s.length / 2 }, (_, i) => (s[2 * i]! + s[2 * i + 1]!) / 65536);
    };

    // 50 Hz: the title music, for comparison.
    const pal = new AudioCapture();
    const palGame = await bootGame(moduleUrl, cartridge, { hz: 50, ...pal.hooks });
    for (let k = 0; k < 50 * 50; k++) expect((await palGame.frame()).fatal).toBeUndefined();

    // 60 Hz: the whole script, every display list interpreted.
    const cap = new AudioCapture();
    const interpreter = new DisplayListInterpreter();
    const problems: string[] = [];
    let frame = 0;
    let bytes = 0;
    let buffers = 0;
    let smallest = Infinity;
    let largest = 0;
    const game = await bootGame(moduleUrl, cartridge, {
      hz: 60,
      onGfxTask: (task) => {
        const result = interpreter.run(task.ram, task.data);
        problems.push(...result.unknown.map((u) => `frame ${frame} unknown 0x${u.w0.toString(16)}`), ...result.problems);
      },
      onAudioTask: cap.hooks.onAudioTask,
      onAiBuffer: (b) => {
        cap.hooks.onAiBuffer(b);
        bytes += b.length;
        buffers++;
        smallest = Math.min(smallest, b.length);
        largest = Math.max(largest, b.length);
      },
    });
    expect(game.rd32(0x80000300)).toBe(1);
    const WINDOW = [9000, 18000] as const;
    let gfxAtStart = 0;
    let last;
    for (frame = 1; frame <= WALKED_RIGHT_FRAME; frame++) {
      const pad = padAt(SCRIPT, frame);
      game.setPad(pad.buttons, pad.x, pad.y);
      last = await game.frame();
      expect(last.fatal, `frame ${frame}`).toBeUndefined();
      expect(last.alive, `frame ${frame}`).toBe(true);
      if (frame === WINDOW[0]) gfxAtStart = last.gfxTasks;
      if (frame === WINDOW[1]) {
        // 9000 retraces of virtual time at 60 Hz are 150 s.
        const perSecond = (last.gfxTasks - gfxAtStart) / ((WINDOW[1] - WINDOW[0]) / 60);
        expect(perSecond).toBeGreaterThan(20 * 0.98);
        expect(perSecond).toBeLessThan(20 * 1.02);
      }
      if (frame === FOREST_FRAME) expect(playState((a) => game.rd32(a))?.scene).not.toBe(HOUSE_SCENE);
    }
    expect(playState((a) => game.rd32(a))?.scene).toBe(HOUSE_SCENE);
    expect(problems).toEqual([]);

    // The audio interface keeps its rate (the NTSC clock over the divisor), is fed what it plays and never runs dry.
    expect(cap.hz).toBe(Math.floor(0x02e6d354 / 1521));
    const seconds = (WALKED_RIGHT_FRAME - 1) / 60;
    expect(bytes / 4 / seconds / cap.hz).toBeGreaterThan(0.99);
    expect(bytes / 4 / seconds / cap.hz).toBeLessThan(1.01);
    // One buffer per audio task, as many as retraces, each of about 1/60 s.
    expect(buffers / seconds).toBeGreaterThan(59);
    expect(buffers / seconds).toBeLessThan(61);
    expect(smallest).toBeGreaterThanOrEqual(2112);
    expect(largest).toBeLessThanOrEqual(2240);
    expect(last!.aiGaps).toBe(0);

    // Same pitch as at 50 Hz, and the music keeps its real-time tempo while the game runs 1.2 times faster. The script presses Start
    // 40 s into the 60 Hz run, so only the title music before that is compared.
    const palSound = mono(pal), sound = mono(cap).subarray(0, 38 * cap.hz);
    // No crackle: samples that jump (second difference over 6000 of 32768) stay within a handful of those at 50 Hz (the unfixed 60 Hz mode had dozens).
    const jumps = (x: Float64Array) => x.reduce((n, v, i) => (i > 1 && Math.abs(v - 2 * x[i - 1]! + x[i - 2]!) > 6000 / 32768 ? n + 1 : n), 0);
    expect(jumps(sound)).toBeLessThanOrEqual(jumps(palSound) + 10);
    const spectra = [averageSpectrum(palSound), averageSpectrum(sound)] as const;
    const match = [0.85, 0.9, 1, 1.1, 1.2].map((stretch) => similarity(spectra[0], spectra[1], 20, 800, stretch));
    expect(match[2]).toBeGreaterThan(0.8);
    expect(match[2]).toBe(Math.max(...match));
    const pace = playbackSpeed(envelope(palSound, 320), envelope(sound, 320), 1500, 3500);
    expect(pace.correlation).toBeGreaterThan(0.8);
    expect(pace.speed).toBeGreaterThan(0.98);
    expect(pace.speed).toBeLessThan(1.02);
  }, 3_600_000);
});
