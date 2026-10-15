// Installs Emscripten once before any test file runs, so parallel suites never race to fetch it.
import { ensureToolchain } from './toolchain.ts';

export default function setup(): void {
  ensureToolchain((m) => console.log(m));
}
