// Compares what the display-list interpreter computes for a graphics task with what the graphics microcode computes on the
// same task (tools/gfx/ucode-ref.ts): the vertices it loads and the pixels its triangles cover. Used by tests only.
import { DisplayListInterpreter } from './dl.ts';
import { GfxMicrocodeRef } from './ucode-ref.ts';

const WIDTH = 320;
const HEIGHT = 240;

/** Instruction-memory address of the command dispatch, which the microcode reaches after each command, and of the vertex load. */
const DISPATCH = 0x19c;
const VERTEX_LOAD = 0x4f0;
/** Data-memory address of the first vertex record and the size of a record; fields: x y z w (s16 each, then their fractions at +8), colour at +0x10, s and t at +0x14. */
const VERTEX_RECORDS = 0x420;
const RECORD_BYTES = 0x28;

export interface Comparison {
  /** Largest difference of a colour channel in 1/255, or a quarter of the difference of the fog factor (the alpha byte). */
  colourError: number;
  /** Largest difference of a texture coordinate in units of 10.5 fixed point. */
  textureError: number;
  /** Largest difference of the clip-space coordinates. */
  positionError: number;
  /** Share of covered pixels covered by one side only, over the triangles that survive face culling. */
  coverageDifference: number;
  vertices: number;
}

interface LoadEvent {
  w0: number;
  vertices: ({ clip: number[]; color: number[]; s: number; t: number } | undefined)[];
}

/** Triangle commands of the RDP command stream: opcode, offset and length. */
function rdpTriangles(bytes: Uint8Array): { off: number }[] {
  const out: { off: number }[] = [];
  for (let o = 0; o + 8 <= bytes.length;) {
    const op = bytes[o]! & 0x3f;
    let len = 8;
    if (op === 0x24 || op === 0x25) len = 16;
    else if (op >= 8 && op <= 15) {
      len = 32 + (op & 4 ? 64 : 0) + (op & 2 ? 64 : 0) + (op & 1 ? 16 : 0);
      out.push({ off: o });
    }
    o += len;
  }
  return out;
}

/** The three vertices of an RDP triangle in pixels: the top one, the one at the middle height and the lowest. */
function trianglePoints(bytes: Uint8Array, off: number): { x: number; y: number }[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset + off, 32);
  const w0 = dv.getUint32(0), w1 = dv.getUint32(4);
  const fixed14 = (v: number) => ((v & 0x3fff) << 18 >> 18) / 4;
  const yl = fixed14(w0), ym = fixed14(w1 >>> 16), yh = fixed14(w1);
  const xl = dv.getInt32(8) / 65536, xh = dv.getInt32(16) / 65536, dxh = dv.getInt32(20) / 65536;
  return [{ x: xh, y: yh }, { x: xl, y: ym }, { x: xh + dxh * (yl - yh), y: yl }];
}

function cover(mask: Uint8Array, p: { x: number; y: number }[]): void {
  const area = (p[1]!.x - p[0]!.x) * (p[2]!.y - p[0]!.y) - (p[2]!.x - p[0]!.x) * (p[1]!.y - p[0]!.y);
  if (Math.abs(area) < 1e-9) return;
  const x0 = Math.max(0, Math.floor(Math.min(p[0]!.x, p[1]!.x, p[2]!.x))), x1 = Math.min(WIDTH - 1, Math.ceil(Math.max(p[0]!.x, p[1]!.x, p[2]!.x)));
  const y0 = Math.max(0, Math.floor(Math.min(p[0]!.y, p[1]!.y, p[2]!.y))), y1 = Math.min(HEIGHT - 1, Math.ceil(Math.max(p[0]!.y, p[1]!.y, p[2]!.y)));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const a = ((p[1]!.x - px) * (p[2]!.y - py) - (p[2]!.x - px) * (p[1]!.y - py)) / area;
      const b = ((p[2]!.x - px) * (p[0]!.y - py) - (p[0]!.x - px) * (p[2]!.y - py)) / area;
      if (a >= 0 && b >= 0 && 1 - a - b >= 0) mask[y * WIDTH + x] = 1;
    }
  }
}

/** Runs the interpreter and the microcode on the task and compares them; `ram` is not modified. */
export function compareWithMicrocode(ram: Uint8Array, data: number, task: number): Comparison {
  const interpreter = new DisplayListInterpreter();
  const events: LoadEvent[] = [];
  // The interpreter's vertex slots after each vertex load, to be read against the microcode's records at the same moment.
  const internals = interpreter as unknown as { loadVertices(w0: number, w1: number): void; verts: LoadEvent['vertices'] };
  const original = internals.loadVertices.bind(interpreter);
  internals.loadVertices = (w0, w1) => {
    original(w0, w1);
    events.push({ w0, vertices: internals.verts.map((v) => v && { clip: [...v.clip], color: [...v.color], s: v.s, t: v.t }) });
  };
  const result = interpreter.run(ram, data);

  const micro = new GfxMicrocodeRef();
  const snapshots: Uint8Array[] = [];
  let loading = false;
  micro.trace = (pc) => {
    if (pc === VERTEX_LOAD) loading = true;
    else if (pc === DISPATCH && loading) {
      loading = false;
      snapshots.push(micro.dmem.slice());
    }
  };
  micro.runTask(ram.slice(), task);

  const out: Comparison = { colourError: 0, textureError: 0, positionError: 0, coverageDifference: 0, vertices: 0 };
  for (let k = 0; k < Math.min(events.length, snapshots.length); k++) {
    const event = events[k]!, dmem = snapshots[k]!;
    const count = (event.w0 >>> 12) & 0xff, first = ((event.w0 >>> 1) & 0x7f) - count;
    for (let i = 0; i < count; i++) {
      const v = event.vertices[first + i];
      if (!v) continue;
      const at = VERTEX_RECORDS + RECORD_BYTES * (first + i);
      const dv = new DataView(dmem.buffer, at);
      for (let c = 0; c < 4; c++) {
        const d = Math.abs(dmem[at + 0x10 + c]! - v.color[c]! * 255);
        out.colourError = Math.max(out.colourError, c === 3 ? d / 4 : d);
        out.positionError = Math.max(out.positionError, Math.abs(dv.getInt16(c * 2) + dv.getUint16(8 + c * 2) / 65536 - v.clip[c]!));
      }
      out.textureError = Math.max(out.textureError, Math.abs(dv.getInt16(0x14) - v.s * 32), Math.abs(dv.getInt16(0x16) - v.t * 32));
      out.vertices++;
    }
  }

  const ours = new Uint8Array(WIDTH * HEIGHT), theirs = new Uint8Array(WIDTH * HEIGHT);
  for (const b of result.batches) {
    if (b.kind !== 'triangles') continue;
    const vp = b.state.viewport;
    const culls = b.state.geometryMode & 0x600;
    for (let i = 0; i < b.positions.length / 12; i++) {
      const p = [0, 1, 2].map((k) => {
        const o = (i * 3 + k) * 4;
        const w = b.positions[o + 3]!;
        return { x: vp.trans[0] / 4 + (b.positions[o]! / w) * (vp.scale[0] / 4), y: vp.trans[1] / 4 - (b.positions[o + 1]! / w) * (vp.scale[1] / 4) };
      });
      const area = (p[1]!.x - p[0]!.x) * (p[2]!.y - p[0]!.y) - (p[2]!.x - p[0]!.x) * (p[1]!.y - p[0]!.y);
      if (area === 0) continue;
      const front = area < 0;
      if (((culls & 0x400) !== 0 && !front) || ((culls & 0x200) !== 0 && front)) continue;
      cover(ours, p);
    }
  }
  const stream = new Uint8Array(micro.rdp.reduce((n, c) => n + c.bytes.length, 0));
  let at = 0;
  for (const c of micro.rdp) { stream.set(c.bytes, at); at += c.bytes.length; }
  for (const t of rdpTriangles(stream)) cover(theirs, trianglePoints(stream, t.off));
  let both = 0, one = 0;
  for (let i = 0; i < ours.length; i++) {
    if (ours[i] && theirs[i]) both++;
    else if (ours[i] || theirs[i]) one++;
  }
  out.coverageDifference = one / Math.max(1, both + one);
  return out;
}
