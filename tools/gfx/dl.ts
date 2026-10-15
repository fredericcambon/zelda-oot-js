// Display-list interpreter: walks a graphics task's command list over a RAM image and produces draw batches in a form
// no renderer is assumed for. Vertices are transformed to clip space, lit, and grouped by the render state they were
// drawn with; textures are decoded to RGBA8.
import { bitsPerTexel, decodeTexture, Fmt, Siz, type RgbaImage } from './decode.ts';
import { Geo, MoveMem, MoveWord, MtxParam, Op } from './opcodes.ts';

export interface TileState {
  fmt: number;
  siz: number;
  /** Row length in 64-bit TMEM words. */
  line: number;
  /** TMEM address in 64-bit words. */
  tmem: number;
  palette: number;
  cmT: number;
  maskT: number;
  shiftT: number;
  cmS: number;
  maskS: number;
  shiftS: number;
  /** Tile bounds in 10.2 fixed point texels. */
  uls: number;
  ult: number;
  lrs: number;
  lrt: number;
  /** True once SetTileSize has been executed for the tile. */
  sized: boolean;
}

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface PrimColor extends Rgba {
  minLod: number;
  lodFrac: number;
}

export interface CombineStage {
  /** Selector codes of the four inputs (A - B) * C + D of the colour and alpha equations, as the hardware numbers them. */
  rgb: [number, number, number, number];
  alpha: [number, number, number, number];
}

export interface Combine {
  raw: [number, number];
  /** Cycle 0 and cycle 1 (the second is used in two-cycle mode). */
  cycles: [CombineStage, CombineStage];
}

export interface Viewport {
  /** Scale and translation in 10.2 fixed point screen units, (x, y, z). */
  scale: [number, number, number];
  trans: [number, number, number];
}

export interface DecodedTexture extends RgbaImage {
  /** Index of the tile descriptor the image was decoded for. */
  tile: number;
}

/** The render state a batch of primitives was drawn with. Immutable once stored in a batch. */
export interface DrawState {
  geometryMode: number;
  otherModeH: number;
  otherModeL: number;
  combine: Combine;
  primColor: PrimColor;
  envColor: Rgba;
  fogColor: Rgba;
  blendColor: Rgba;
  fillColor: number;
  texture: { on: boolean; level: number; tile: number; scaleS: number; scaleT: number };
  /** The eight tile descriptors. */
  tiles: TileState[];
  /** Decoded images of the tile the texture command names and the one after it; null when nothing is loaded for it. */
  textures: [DecodedTexture | null, DecodedTexture | null];
  viewport: Viewport;
  scissor: { mode: number; xh: number; yh: number; xl: number; yl: number };
  fog: { multiplier: number; offset: number };
  colorImage: { fmt: number; siz: number; width: number; addr: number };
  depthImage: number;
}

export interface TriangleBatch {
  kind: 'triangles';
  state: DrawState;
  /** Three consecutive vertices per triangle. Positions are clip-space (x, y, z, w), four floats each. */
  positions: Float32Array;
  /** Colours in 0..1 (lit when lighting was on), four floats per vertex. */
  colors: Float32Array;
  /**
   * Texture coordinates in texels of the vertex's own S10.5 value times the texture command's scale, two floats per
   * vertex. With texture generation on they are the generated coordinates in 0..1 instead.
   */
  uvs: Float32Array;
  /** Fog factor in 0..1 per vertex (0 when fog is off). */
  fog: Float32Array;
}

export interface RectBatch {
  kind: 'texrect' | 'fillrect';
  state: DrawState;
  /** Corners in 10.2 fixed point screen units. */
  xl: number;
  yl: number;
  xh: number;
  yh: number;
  tile: number;
  /** Texture start and per-pixel steps for a texture rectangle, S10.5 and S5.10; zero for a fill rectangle. */
  s: number;
  t: number;
  dsdx: number;
  dtdy: number;
}

export type Batch = TriangleBatch | RectBatch;

export interface UnknownCommand {
  addr: number;
  w0: number;
  w1: number;
}

export interface DisplayListResult {
  batches: Batch[];
  /** Number of commands executed. */
  commands: number;
  /** How many times each first-byte opcode was executed. */
  opcodes: Map<number, number>;
  unknown: UnknownCommand[];
  /** Inconsistencies in the list that the interpreter worked around, such as a bad segment or a matrix underflow. */
  problems: string[];
}

export interface RunOptions {
  /** Stop after this many commands (a runaway list). */
  maxCommands?: number;
}

type Mat = Float64Array; // 4x4, row-major, for row vectors

const identity = (): Mat => Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);

function mul(a: Mat, b: Mat): Mat {
  const o = new Float64Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[r * 4 + k]! * b[k * 4 + c]!;
    o[r * 4 + c] = s;
  }
  return o;
}

const MAX_DL_DEPTH = 32;
const VERTEX_SLOTS = 32;
const TMEM_BYTES = 4096;

interface Vertex {
  clip: [number, number, number, number];
  color: [number, number, number, number];
  s: number;
  t: number;
  fog: number;
}

function newTile(): TileState {
  return {
    fmt: 0, siz: 0, line: 0, tmem: 0, palette: 0, cmT: 0, maskT: 0, shiftT: 0, cmS: 0, maskS: 0, shiftS: 0,
    uls: 0, ult: 0, lrs: 0, lrt: 0, sized: false,
  };
}

export function decodeCombine(w0: number, w1: number): Combine {
  const cycle0: CombineStage = {
    rgb: [(w0 >>> 20) & 15, (w1 >>> 28) & 15, (w0 >>> 15) & 31, (w1 >>> 15) & 7],
    alpha: [(w0 >>> 12) & 7, (w1 >>> 12) & 7, (w0 >>> 9) & 7, (w1 >>> 9) & 7],
  };
  const cycle1: CombineStage = {
    rgb: [(w0 >>> 5) & 15, (w1 >>> 24) & 15, w0 & 31, (w1 >>> 6) & 7],
    alpha: [(w1 >>> 21) & 7, (w1 >>> 3) & 7, (w1 >>> 18) & 7, w1 & 7],
  };
  return { raw: [w0 >>> 0, w1 >>> 0], cycles: [cycle0, cycle1] };
}

const color = (w: number): Rgba => ({ r: (w >>> 24) & 255, g: (w >>> 16) & 255, b: (w >>> 8) & 255, a: w & 255 });

export class DisplayListInterpreter {
  private dv!: DataView;
  private ram!: Uint8Array;
  private seg = new Array<number>(16).fill(0);
  private mv: Mat = identity();
  private proj: Mat = identity();
  private mvStack: Mat[] = [];
  private mvp: Mat | null = null;
  private verts: (Vertex | undefined)[] = [];
  private tmem = new Uint8Array(TMEM_BYTES);
  private tiles: TileState[] = [];
  private timg = { fmt: 0, siz: 0, width: 1, addr: 0 };
  private geometryMode = 0;
  private otherH = 0;
  private otherL = 0;
  private combine = decodeCombine(0, 0);
  private prim: PrimColor = { r: 0, g: 0, b: 0, a: 0, minLod: 0, lodFrac: 0 };
  private env: Rgba = { r: 0, g: 0, b: 0, a: 0 };
  private fogColor: Rgba = { r: 0, g: 0, b: 0, a: 0 };
  private blend: Rgba = { r: 0, g: 0, b: 0, a: 0 };
  private fill = 0;
  private texture = { on: false, level: 0, tile: 0, scaleS: 0, scaleT: 0 };
  private viewport: Viewport = { scale: [0, 0, 0], trans: [0, 0, 0] };
  private scissor = { mode: 0, xh: 0, yh: 0, xl: 0, yl: 0 };
  private fog = { multiplier: 0, offset: 0 };
  private cimg = { fmt: 0, siz: 0, width: 0, addr: 0 };
  private zimg = 0;
  private numLights = 0;
  /** Slot 0 and 1 are the look-at vectors, then the lights, then the ambient light. */
  private lightSlots: Uint8Array[] = [];
  private snapshot: DrawState | null = null;
  private tmemVersion = 0;
  private textureCache = new Map<string, DecodedTexture | null>();
  private result!: DisplayListResult;
  private current: { batch: TriangleBatch; pos: number[]; col: number[]; uv: number[]; fog: number[] } | null = null;

  /** Interprets the list starting at `start` (a segmented address) in `ram`, a big-endian image indexed by physical address. */
  run(ram: Uint8Array, start: number, opts: RunOptions = {}): DisplayListResult {
    this.ram = ram;
    this.dv = new DataView(ram.buffer, ram.byteOffset, ram.byteLength);
    this.reset();
    const result: DisplayListResult = { batches: [], commands: 0, opcodes: new Map(), unknown: [], problems: [] };
    this.result = result;
    const maxCommands = opts.maxCommands ?? 5_000_000;
    const stack: number[] = [];
    let pc = this.address(start);
    let running = pc >= 0;
    while (running && result.commands < maxCommands) {
      if (pc + 8 > ram.length) { this.problem(`list runs off memory at 0x${pc.toString(16)}`); break; }
      const w0 = this.dv.getUint32(pc);
      const w1 = this.dv.getUint32(pc + 4);
      const op = w0 >>> 24;
      const at = pc;
      pc += 8;
      result.commands++;
      result.opcodes.set(op, (result.opcodes.get(op) ?? 0) + 1);
      switch (op) {
        case Op.DL: {
          const target = this.address(w1);
          if (target < 0) break;
          if ((w0 >>> 16) & 1) pc = target;
          else if (stack.length >= MAX_DL_DEPTH) this.problem('display list nesting too deep');
          else { stack.push(pc); pc = target; }
          break;
        }
        case Op.ENDDL: {
          const back = stack.pop();
          if (back === undefined) running = false;
          else pc = back;
          break;
        }
        case Op.CULLDL:
          if (this.cullList(w0, w1)) {
            const back = stack.pop();
            if (back === undefined) running = false;
            else pc = back;
          }
          break;
        case Op.TEXRECT: {
          const h1 = pc + 8 <= ram.length ? this.dv.getUint32(pc) >>> 24 : 0;
          const h2 = pc + 16 <= ram.length ? this.dv.getUint32(pc + 8) >>> 24 : 0;
          if (h1 === Op.RDPHALF_1 && h2 === Op.RDPHALF_2) {
            this.texRect(w0, w1, this.dv.getUint32(pc + 4), this.dv.getUint32(pc + 12));
            result.commands += 2;
            result.opcodes.set(h1, (result.opcodes.get(h1) ?? 0) + 1);
            result.opcodes.set(h2, (result.opcodes.get(h2) ?? 0) + 1);
            pc += 16;
          } else this.problem(`texture rectangle at 0x${at.toString(16)} is not followed by its two half-words`);
          break;
        }
        default:
          if (!this.execute(op, w0, w1)) result.unknown.push({ addr: at, w0, w1 });
      }
    }
    this.finishBatch();
    return result;
  }

  private reset(): void {
    this.seg.fill(0);
    this.mv = identity();
    this.proj = identity();
    this.mvStack = [];
    this.mvp = null;
    this.verts = new Array<Vertex | undefined>(VERTEX_SLOTS).fill(undefined);
    this.tmem.fill(0);
    this.tiles = Array.from({ length: 8 }, newTile);
    this.timg = { fmt: 0, siz: 0, width: 1, addr: 0 };
    this.geometryMode = 0;
    this.otherH = 0;
    this.otherL = 0;
    this.combine = decodeCombine(0, 0);
    this.prim = { r: 0, g: 0, b: 0, a: 0, minLod: 0, lodFrac: 0 };
    this.env = { r: 0, g: 0, b: 0, a: 0 };
    this.fogColor = { r: 0, g: 0, b: 0, a: 0 };
    this.blend = { r: 0, g: 0, b: 0, a: 0 };
    this.fill = 0;
    this.texture = { on: false, level: 0, tile: 0, scaleS: 0, scaleT: 0 };
    this.viewport = { scale: [0, 0, 0], trans: [0, 0, 0] };
    this.scissor = { mode: 0, xh: 0, yh: 0, xl: 0, yl: 0 };
    this.fog = { multiplier: 0, offset: 0 };
    this.cimg = { fmt: 0, siz: 0, width: 0, addr: 0 };
    this.zimg = 0;
    this.numLights = 0;
    this.lightSlots = Array.from({ length: 10 }, () => new Uint8Array(16));
    this.snapshot = null;
    this.tmemVersion = 0;
    this.textureCache.clear();
    this.current = null;
  }

  private problem(msg: string): void {
    if (this.result.problems.length < 100) this.result.problems.push(msg);
  }

  /** Physical address of a segmented address, or -1 (and a problem) when it lies outside RAM. */
  private address(a: number): number {
    const p = (this.seg[(a >>> 24) & 15]! + (a & 0xffffff)) >>> 0;
    if (p >= this.ram.length) {
      this.problem(`address 0x${(a >>> 0).toString(16)} resolves outside RAM (0x${p.toString(16)})`);
      return -1;
    }
    return p;
  }

  private invalidate(): void {
    this.snapshot = null;
  }

  /** Executes a command other than the control-flow ones; false when the opcode is not a known command. */
  private execute(op: number, w0: number, w1: number): boolean {
    switch (op) {
      case Op.VTX: this.loadVertices(w0, w1); break;
      case Op.TRI1: this.triangle((w0 >>> 16) & 255, (w0 >>> 8) & 255, w0 & 255); break;
      case Op.TRI2:
      case Op.QUAD:
        // A quad is drawn as the two triangles of the same encoding.
        this.triangle((w0 >>> 16) & 255, (w0 >>> 8) & 255, w0 & 255);
        this.triangle((w1 >>> 16) & 255, (w1 >>> 8) & 255, w1 & 255);
        break;
      case Op.TEXTURE:
        this.texture = { on: (w0 & 0xff) !== 0, level: (w0 >>> 11) & 7, tile: (w0 >>> 8) & 7, scaleS: w1 >>> 16, scaleT: w1 & 0xffff };
        this.invalidate();
        break;
      case Op.POPMTX: this.popMatrix(w1); break;
      case Op.GEOMETRYMODE:
        this.geometryMode = ((this.geometryMode & w0 & 0xffffff) | w1) >>> 0;
        this.invalidate();
        break;
      case Op.MTX: this.loadMatrix(w0, w1); break;
      case Op.MOVEWORD: this.moveWord(w0, w1); break;
      case Op.MOVEMEM: this.moveMem(w0, w1); break;
      case Op.RDPHALF_1:
      case Op.RDPHALF_2:
        this.problem(`stray rdp half-word 0x${op.toString(16)}`);
        break;
      case Op.SETOTHERMODE_L: this.setOtherMode(false, w0, w1); break;
      case Op.SETOTHERMODE_H: this.setOtherMode(true, w0, w1); break;
      case Op.RDPLOADSYNC:
      case Op.RDPPIPESYNC:
      case Op.RDPTILESYNC:
      case Op.RDPFULLSYNC:
        break;
      case Op.SETSCISSOR:
        this.scissor = { mode: (w1 >>> 24) & 3, xh: (w0 >>> 12) & 0xfff, yh: w0 & 0xfff, xl: (w1 >>> 12) & 0xfff, yl: w1 & 0xfff };
        this.invalidate();
        break;
      case Op.SETOTHERMODE:
        this.otherH = (this.otherH & 0xff000000 | (w0 & 0xffffff)) >>> 0;
        this.otherL = w1 >>> 0;
        this.invalidate();
        break;
      case Op.LOADTLUT: this.loadTlut(w0, w1); break;
      case Op.SETTILESIZE: this.setTileSize(w0, w1); break;
      case Op.LOADBLOCK: this.loadBlock(w0, w1); break;
      case Op.LOADTILE: this.loadTile(w0, w1); break;
      case Op.SETTILE: this.setTile(w0, w1); break;
      case Op.FILLRECT: this.fillRect(w0, w1); break;
      case Op.SETFILLCOLOR: this.fill = w1 >>> 0; this.invalidate(); break;
      case Op.SETFOGCOLOR: this.fogColor = color(w1); this.invalidate(); break;
      case Op.SETBLENDCOLOR: this.blend = color(w1); this.invalidate(); break;
      case Op.SETPRIMCOLOR:
        this.prim = { ...color(w1), minLod: (w0 >>> 8) & 31, lodFrac: w0 & 255 };
        this.invalidate();
        break;
      case Op.SETENVCOLOR: this.env = color(w1); this.invalidate(); break;
      case Op.SETCOMBINE: this.combine = decodeCombine(w0 & 0xffffff, w1); this.invalidate(); break;
      case Op.SETTIMG: {
        const addr = this.address(w1);
        this.timg = { fmt: (w0 >>> 21) & 7, siz: (w0 >>> 19) & 3, width: (w0 & 0xfff) + 1, addr: Math.max(addr, 0) };
        break;
      }
      case Op.SETZIMG: this.zimg = Math.max(this.address(w1), 0); this.invalidate(); break;
      case Op.SETCIMG:
        this.cimg = { fmt: (w0 >>> 21) & 7, siz: (w0 >>> 19) & 3, width: (w0 & 0xfff) + 1, addr: Math.max(this.address(w1), 0) };
        this.invalidate();
        break;
      default:
        return false;
    }
    return true;
  }

  // ---- Matrices and vertices -------------------------------------------------------------------------------------

  /** A 4x4 matrix in the game's fixed-point layout: sixteen s16 integer parts, then sixteen u16 fractions. */
  private readMatrix(addr: number): Mat {
    const m = new Float64Array(16);
    for (let i = 0; i < 16; i++) m[i] = this.dv.getInt16(addr + i * 2) + this.dv.getUint16(addr + 32 + i * 2) / 65536;
    return m;
  }

  private loadMatrix(w0: number, w1: number): void {
    // The push bit is stored inverted.
    const params = (w0 & 0xff) ^ MtxParam.PUSH;
    const addr = this.address(w1);
    if (addr < 0 || addr + 64 > this.ram.length) return;
    const m = this.readMatrix(addr);
    if (params & MtxParam.PROJECTION) {
      this.proj = params & MtxParam.LOAD ? m : mul(m, this.proj);
    } else {
      if (params & MtxParam.PUSH) this.mvStack.push(this.mv);
      this.mv = params & MtxParam.LOAD ? m : mul(m, this.mv);
    }
    this.mvp = null;
  }

  private popMatrix(w1: number): void {
    for (let n = w1 / 64; n > 0; n--) {
      const m = this.mvStack.pop();
      if (m) this.mv = m;
      else this.problem('matrix stack underflow');
    }
    this.mvp = null;
  }

  private loadVertices(w0: number, w1: number): void {
    const n = (w0 >>> 12) & 0xff;
    const v0 = ((w0 >>> 1) & 0x7f) - n;
    const addr = this.address(w1);
    if (addr < 0) return;
    if (v0 < 0 || v0 + n > VERTEX_SLOTS) { this.problem(`vertex load of ${n} at ${v0} does not fit the buffer`); return; }
    if (addr + n * 16 > this.ram.length) return;
    this.mvp ??= mul(this.mv, this.proj);
    const m = this.mvp;
    const lighting = (this.geometryMode & Geo.LIGHTING) !== 0;
    const texgen = (this.geometryMode & Geo.TEXTURE_GEN) !== 0;
    const fogOn = (this.geometryMode & Geo.FOG) !== 0;
    const scaleS = this.texture.scaleS / 0x10000;
    const scaleT = this.texture.scaleT / 0x10000;
    for (let i = 0; i < n; i++) {
      const a = addr + i * 16;
      const x = this.dv.getInt16(a), y = this.dv.getInt16(a + 2), z = this.dv.getInt16(a + 4);
      const clip: Vertex['clip'] = [
        x * m[0]! + y * m[4]! + z * m[8]! + m[12]!,
        x * m[1]! + y * m[5]! + z * m[9]! + m[13]!,
        x * m[2]! + y * m[6]! + z * m[10]! + m[14]!,
        x * m[3]! + y * m[7]! + z * m[11]! + m[15]!,
      ];
      const alpha = this.ram[a + 15]! / 255;
      let col: Vertex['color'];
      let s = this.dv.getInt16(a + 8) / 32 * scaleS;
      let t = this.dv.getInt16(a + 10) / 32 * scaleT;
      if (lighting) {
        const normal = this.viewNormal(this.dv.getInt8(a + 12), this.dv.getInt8(a + 13), this.dv.getInt8(a + 14));
        col = this.light(normal, alpha);
        if (texgen) {
          const lx = this.lightSlots[0]!, ly = this.lightSlots[1]!;
          s = (dot3(normal, lx) * 0.5 + 0.5);
          t = (dot3(normal, ly) * 0.5 + 0.5);
        }
      } else col = [this.ram[a + 12]! / 255, this.ram[a + 13]! / 255, this.ram[a + 14]! / 255, alpha];
      let fog = 0;
      if (fogOn && clip[3] !== 0) {
        fog = Math.min(255, Math.max(0, (clip[2] / clip[3]) * this.fog.multiplier + this.fog.offset)) / 255;
      }
      this.verts[v0 + i] = { clip, color: col, s, t, fog };
    }
  }

  private viewNormal(nx: number, ny: number, nz: number): [number, number, number] {
    const m = this.mv;
    const x = nx * m[0]! + ny * m[4]! + nz * m[8]!;
    const y = nx * m[1]! + ny * m[5]! + nz * m[9]!;
    const z = nx * m[2]! + ny * m[6]! + nz * m[10]!;
    const len = Math.hypot(x, y, z) || 1;
    return [x / len, y / len, z / len];
  }

  private light(n: [number, number, number], alpha: number): Vertex['color'] {
    const amb = this.lightSlots[2 + this.numLights]!;
    const c = [amb[0]! / 255, amb[1]! / 255, amb[2]! / 255];
    for (let i = 0; i < this.numLights; i++) {
      const l = this.lightSlots[2 + i]!;
      const d = Math.max(0, dot3(n, l));
      for (let k = 0; k < 3; k++) c[k]! += (l[k]! / 255) * d;
    }
    return [Math.min(1, c[0]!), Math.min(1, c[1]!), Math.min(1, c[2]!), alpha];
  }

  private moveWord(w0: number, w1: number): void {
    const index = (w0 >>> 16) & 0xff;
    switch (index) {
      case MoveWord.SEGMENT: this.seg[((w0 & 0xffff) >>> 2) & 15] = w1 & 0xffffff; break;
      case MoveWord.NUMLIGHT: this.numLights = Math.min(7, w1 / 24); break;
      case MoveWord.FOG:
        this.fog = { multiplier: (w1 >> 16) | 0, offset: (w1 << 16) >> 16 };
        this.invalidate();
        break;
      case MoveWord.CLIP:
      case MoveWord.PERSPNORM:
        break;
      default:
        this.problem(`moveword of unknown index 0x${index.toString(16)}`);
    }
  }

  private moveMem(w0: number, w1: number): void {
    const index = w0 & 0xff;
    const size = ((((w0 >>> 16) & 0xff) >> 3) + 1) * 8;
    const offset = ((w0 >>> 8) & 0xff) * 8;
    const addr = this.address(w1);
    if (addr < 0) return;
    if (index === MoveMem.VIEWPORT) {
      const g = (k: number) => this.dv.getInt16(addr + k * 2);
      this.viewport = { scale: [g(0), g(1), g(2)], trans: [g(4), g(5), g(6)] };
      this.invalidate();
    } else if (index === MoveMem.LIGHT) {
      const slot = this.lightSlots[offset / 24];
      if (!slot || offset % 24 !== 0 || size > 16) { this.problem(`light load at offset ${offset} of ${size} bytes`); return; }
      slot.set(this.ram.subarray(addr, addr + 16));
    } else this.problem(`movemem to unknown target 0x${index.toString(16)}`);
  }

  private clipFlags(v: Vertex): number {
    const [x, y, , w] = v.clip;
    return (x < -w ? 1 : 0) | (x > w ? 2 : 0) | (y < -w ? 4 : 0) | (y > w ? 8 : 0);
  }

  /** CULLDL: the list ends when every vertex of the range lies outside one side of the screen. */
  private cullList(w0: number, w1: number): boolean {
    const first = (w0 & 0xffff) / 2;
    const last = (w1 & 0xffff) / 2;
    let all = 15;
    for (let i = first; i <= last; i++) {
      const v = this.verts[i];
      if (!v) { this.problem(`cull range uses vertex ${i} that is not loaded`); return false; }
      all &= this.clipFlags(v);
    }
    return all !== 0;
  }

  // ---- Primitives ------------------------------------------------------------------------------------------------

  private triangle(a: number, b: number, c: number): void {
    const vs = [a / 2, b / 2, c / 2].map((i) => this.verts[i]);
    if (vs.some((v) => !v)) { this.problem(`triangle uses vertices ${a / 2}, ${b / 2}, ${c / 2} that are not loaded`); return; }
    const cur = this.currentBatch();
    for (const v of vs as Vertex[]) {
      cur.pos.push(...v.clip);
      cur.col.push(...v.color);
      cur.uv.push(v.s, v.t);
      cur.fog.push(v.fog);
    }
  }

  private currentBatch(): NonNullable<DisplayListInterpreter['current']> {
    if (this.current && this.snapshot) return this.current;
    this.finishBatch();
    const state = this.takeSnapshot();
    const empty = new Float32Array(0);
    this.current = { batch: { kind: 'triangles', state, positions: empty, colors: empty, uvs: empty, fog: empty }, pos: [], col: [], uv: [], fog: [] };
    return this.current;
  }

  private finishBatch(): void {
    const cur = this.current;
    this.current = null;
    if (!cur || cur.pos.length === 0) return;
    cur.batch.positions = Float32Array.from(cur.pos);
    cur.batch.colors = Float32Array.from(cur.col);
    cur.batch.uvs = Float32Array.from(cur.uv);
    cur.batch.fog = Float32Array.from(cur.fog);
    this.result.batches.push(cur.batch);
  }

  private texRect(w0: number, w1: number, half1: number, half2: number): void {
    this.finishBatch();
    const tile = (w1 >>> 24) & 7;
    this.result.batches.push({
      kind: 'texrect', state: this.takeSnapshot(tile),
      xl: (w0 >>> 12) & 0xfff, yl: w0 & 0xfff, xh: (w1 >>> 12) & 0xfff, yh: w1 & 0xfff, tile,
      s: half1 >> 16, t: (half1 << 16) >> 16, dsdx: (half2 >> 16), dtdy: (half2 << 16) >> 16,
    });
  }

  private fillRect(w0: number, w1: number): void {
    this.finishBatch();
    this.result.batches.push({
      kind: 'fillrect', state: this.takeSnapshot(),
      xl: (w0 >>> 12) & 0xfff, yl: w0 & 0xfff, xh: (w1 >>> 12) & 0xfff, yh: w1 & 0xfff, tile: 0, s: 0, t: 0, dsdx: 0, dtdy: 0,
    });
  }

  private takeSnapshot(textureTile = this.texture.tile): DrawState {
    const tiles = this.tiles.map((t) => ({ ...t }));
    const state: DrawState = {
      geometryMode: this.geometryMode, otherModeH: this.otherH, otherModeL: this.otherL, combine: this.combine,
      primColor: this.prim, envColor: this.env, fogColor: this.fogColor, blendColor: this.blend, fillColor: this.fill,
      texture: { ...this.texture }, tiles,
      textures: [this.decodeTile(textureTile), this.decodeTile((textureTile + 1) & 7)],
      viewport: this.viewport, scissor: this.scissor, fog: this.fog, colorImage: this.cimg, depthImage: this.zimg,
    };
    this.snapshot = state;
    return state;
  }

  // ---- Textures --------------------------------------------------------------------------------------------------

  private setTile(w0: number, w1: number): void {
    const t = this.tiles[(w1 >>> 24) & 7]!;
    t.fmt = (w0 >>> 21) & 7;
    t.siz = (w0 >>> 19) & 3;
    t.line = (w0 >>> 9) & 0x1ff;
    t.tmem = w0 & 0x1ff;
    t.palette = (w1 >>> 20) & 15;
    t.cmT = (w1 >>> 18) & 3;
    t.maskT = (w1 >>> 14) & 15;
    t.shiftT = (w1 >>> 10) & 15;
    t.cmS = (w1 >>> 8) & 3;
    t.maskS = (w1 >>> 4) & 15;
    t.shiftS = w1 & 15;
    this.invalidate();
  }

  private setTileSize(w0: number, w1: number): void {
    const t = this.tiles[(w1 >>> 24) & 7]!;
    t.uls = (w0 >>> 12) & 0xfff;
    t.ult = w0 & 0xfff;
    t.lrs = (w1 >>> 12) & 0xfff;
    t.lrt = w1 & 0xfff;
    t.sized = true;
    this.invalidate();
  }

  /** Bytes a row of `texels` texels takes in an image of the given size. */
  private rowBytesOf(texels: number, siz: number): number {
    return Math.ceil((texels * bitsPerTexel(siz)) / 8);
  }

  private store(dest: number, src: number, bytes: number): void {
    const d = dest & (TMEM_BYTES - 1);
    const n = Math.max(0, Math.min(bytes, TMEM_BYTES - d, this.ram.length - src));
    this.tmem.set(this.ram.subarray(src, src + n), d);
    this.tmemVersion++;
    this.invalidate();
  }

  /** The tile's TMEM rows are filled in stream order; a block is the contiguous bytes of the image from the first texel. */
  private loadBlock(w0: number, w1: number): void {
    const t = this.tiles[(w1 >>> 24) & 7]!;
    const uls = (w0 >>> 12) & 0xfff, ult = w0 & 0xfff, lrs = (w1 >>> 12) & 0xfff;
    const src = this.timg.addr + this.rowBytesOf(ult * this.timg.width + uls, this.timg.siz);
    this.store(t.tmem * 8, src, this.rowBytesOf(lrs - uls + 1, this.timg.siz));
  }

  private loadTile(w0: number, w1: number): void {
    const t = this.tiles[(w1 >>> 24) & 7]!;
    const uls = ((w0 >>> 12) & 0xfff) >> 2, ult = (w0 & 0xfff) >> 2;
    const lrs = ((w1 >>> 12) & 0xfff) >> 2, lrt = (w1 & 0xfff) >> 2;
    const imgRow = this.rowBytesOf(this.timg.width, this.timg.siz);
    const bytes = this.rowBytesOf(lrs - uls + 1, this.timg.siz);
    const stride = t.line * (t.siz === Siz.B32 ? 16 : 8);
    for (let y = 0; y <= lrt - ult; y++) {
      this.store(t.tmem * 8 + y * stride, this.timg.addr + (ult + y) * imgRow + this.rowBytesOf(uls, this.timg.siz), bytes);
    }
  }

  /** The palette is stored as 16-bit entries from the tile's TMEM address. */
  private loadTlut(w0: number, w1: number): void {
    const t = this.tiles[(w1 >>> 24) & 7]!;
    const count = (((w1 >>> 12) & 0xfff) >> 2) + 1;
    this.store(t.tmem * 8, this.timg.addr, count * 2);
  }

  private setOtherMode(high: boolean, w0: number, w1: number): void {
    const len = (w0 & 0xff) + 1;
    const shift = 32 - ((w0 >>> 8) & 0xff) - len;
    const mask = (len === 32 ? 0xffffffff : ((1 << len) - 1) << shift) >>> 0;
    if (high) this.otherH = ((this.otherH & ~mask) | (w1 & mask)) >>> 0;
    else this.otherL = ((this.otherL & ~mask) | (w1 & mask)) >>> 0;
    this.invalidate();
  }

  private decodeTile(index: number): DecodedTexture | null {
    const t = this.tiles[index]!;
    if (t.line === 0 || t.fmt === Fmt.YUV) return null;
    const tlutOn = ((this.otherH >>> 14) & 3) !== 0;
    const ia = ((this.otherH >>> 14) & 3) === 3;
    const key = JSON.stringify([t, this.tmemVersion, tlutOn, ia]);
    if (this.textureCache.has(key)) {
      const hit = this.textureCache.get(key);
      return hit ? { ...hit, tile: index } : null;
    }
    const rowBytes = t.line * (t.siz === Siz.B32 ? 16 : 8);
    let width = t.sized ? ((t.lrs - t.uls) >> 2) + 1 : t.maskS ? 1 << t.maskS : Math.floor((rowBytes * 8) / bitsPerTexel(t.siz));
    let height = t.sized ? ((t.lrt - t.ult) >> 2) + 1 : t.maskT ? 1 << t.maskT : 1;
    const maxHeight = Math.floor((TMEM_BYTES - t.tmem * 8) / rowBytes);
    width = Math.max(1, Math.min(width, Math.floor((rowBytes * 8) / bitsPerTexel(t.siz))));
    height = Math.max(0, Math.min(height, maxHeight));
    let out: DecodedTexture | null = null;
    if (height > 0) {
      const pal = t.fmt === Fmt.CI ? { data: this.tmem, offset: (256 + (t.siz === Siz.B4 ? t.palette * 16 : 0)) * 8, ia } : undefined;
      const img = decodeTexture({
        fmt: t.fmt, siz: t.siz, width, height, rowBytes, data: this.tmem,
        offset: t.tmem * 8, palette: pal,
      });
      out = { ...img, tile: index };
    }
    this.textureCache.set(key, out);
    return out;
  }
}

function dot3(n: [number, number, number], l: Uint8Array): number {
  // Directions are signed bytes at offset 8; the byte array holds them raw.
  const d = (k: number) => ((l[8 + k]! << 24) >> 24) / 127;
  return n[0] * d(0) + n[1] * d(1) + n[2] * d(2);
}
