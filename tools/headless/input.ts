// Scripted controller state for unattended runs, one directive per line, `#` starts a comment:
//   <frame> <buttons> [stickX stickY]       from that frame on, until the next such line
//   tap <buttons> <from> <to> <every> <hold> press the buttons for `hold` frames every `every` frames in [from, to)
// Before the first line nothing is pressed. Buttons are names joined by `+` (A B Z START UP DOWN LEFT RIGHT L R CUP
// CDOWN CLEFT CRIGHT), `NONE`, or a number; taps are added to the buttons of the state in force. The stick values
// are signed bytes (a real controller reaches about -80..80).

/** OSContPad button bits (docs/re/input.md). */
export const BUTTONS: Readonly<Record<string, number>> = {
  A: 0x8000, B: 0x4000, Z: 0x2000, START: 0x1000, UP: 0x0800, DOWN: 0x0400, LEFT: 0x0200, RIGHT: 0x0100,
  L: 0x0020, R: 0x0010, CUP: 0x0008, CDOWN: 0x0004, CLEFT: 0x0002, CRIGHT: 0x0001,
};

export interface PadState {
  buttons: number;
  x: number;
  y: number;
}

interface Tap {
  buttons: number;
  from: number;
  to: number;
  every: number;
  hold: number;
}

export interface InputScript {
  states: Array<PadState & { frame: number }>;
  taps: Tap[];
}

function parseButtons(text: string, where: string): number {
  if (/^(0x[0-9a-f]+|\d+)$/i.test(text)) return Number(text) & 0xffff;
  let bits = 0;
  for (const name of text.toUpperCase().split('+')) {
    if (name === 'NONE') continue;
    const bit = BUTTONS[name];
    if (bit === undefined) throw new Error(`${where}: unknown button "${name}"`);
    bits |= bit;
  }
  return bits;
}

export function parseInput(text: string, source = 'input'): InputScript {
  const script: InputScript = { states: [], taps: [] };
  text.split(/\r?\n/).forEach((raw, n) => {
    const words = raw.replace(/#.*/, '').trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return;
    const where = `${source}:${n + 1}`;
    const integer = (s: string | undefined, what: string): number => {
      if (s === undefined || !/^-?\d+$/.test(s)) throw new Error(`${where}: ${what} must be an integer`);
      return Number(s);
    };
    if (words[0] === 'tap') {
      if (words.length !== 6) throw new Error(`${where}: expected "tap <buttons> <from> <to> <every> <hold>"`);
      const tap = { buttons: parseButtons(words[1]!, where), from: integer(words[2], 'from'), to: integer(words[3], 'to'), every: integer(words[4], 'every'), hold: integer(words[5], 'hold') };
      if (tap.every < 1 || tap.hold < 1) throw new Error(`${where}: every and hold must be positive`);
      script.taps.push(tap);
      return;
    }
    if (words.length < 2 || words.length > 4 || words.length === 3) throw new Error(`${where}: expected "<frame> <buttons> [x y]"`);
    const state = { frame: integer(words[0], 'frame'), buttons: parseButtons(words[1]!, where), x: words.length === 4 ? integer(words[2], 'x') : 0, y: words.length === 4 ? integer(words[3], 'y') : 0 };
    if (Math.abs(state.x) > 127 || Math.abs(state.y) > 127) throw new Error(`${where}: stick values must be in -127..127`);
    const prev = script.states[script.states.length - 1];
    if (prev && state.frame <= prev.frame) throw new Error(`${where}: frames must increase`);
    script.states.push(state);
  });
  return script;
}

/** The pad state in force at `frame`. */
export function padAt(script: InputScript, frame: number): PadState {
  let state: PadState = { buttons: 0, x: 0, y: 0 };
  for (const s of script.states) {
    if (s.frame > frame) break;
    state = s;
  }
  let buttons = state.buttons;
  for (const t of script.taps) if (frame >= t.from && frame < t.to && (frame - t.from) % t.every < t.hold) buttons |= t.buttons;
  return { buttons, x: state.x, y: state.y };
}
