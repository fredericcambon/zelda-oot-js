// Installs Emscripten once and builds the shared game and its coverage variant once before any test file runs, so parallel suites never race to
// fetch the toolchain or build their own copy of the game.
import { existsSync } from 'node:fs';
import { lowerPriority } from '../port/limits.ts';
import { buildGames } from './test-base.ts';
import { ensureToolchain } from './toolchain.ts';

export default async function setup(): Promise<void> {
  lowerPriority();
  ensureToolchain((m) => console.log(m));
  const rom = process.env.OOT_ROM;
  if (rom && existsSync(rom)) await buildGames(rom, (m) => console.log(m));
}
