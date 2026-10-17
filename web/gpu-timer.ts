// GPU time of the work submitted between begin() and end(), through EXT_disjoint_timer_query_webgl2. Results arrive a few
// frames later, so they are collected by poll().

interface TimerExtension {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

/** Queries not yet answered beyond which new ones are skipped, so a stalled GPU cannot grow the list without bound. */
const MAX_PENDING = 32;

export type GpuTag = 'task' | 'present';

export class GpuTimer {
  private readonly ext: TimerExtension | null;
  private readonly pending: { query: WebGLQuery; tag: GpuTag }[] = [];
  private active: WebGLQuery | null = null;
  private activeTag: GpuTag = 'task';

  constructor(private readonly gl: WebGL2RenderingContext) {
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as Partial<TimerExtension> | null;
    this.ext = ext && typeof ext.TIME_ELAPSED_EXT === 'number' ? (ext as TimerExtension) : null;
  }

  begin(tag: GpuTag): void {
    if (!this.ext || this.active || this.pending.length >= MAX_PENDING) return;
    const query = this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.active = query;
    this.activeTag = tag;
  }

  end(): void {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push({ query: this.active, tag: this.activeTag });
    this.active = null;
  }

  /** The finished measurements in submission order, in milliseconds; a disjoint GPU (clock change, power event) drops them. */
  poll(): { tag: GpuTag; ms: number }[] {
    const out: { tag: GpuTag; ms: number }[] = [];
    if (!this.ext) return out;
    const gl = this.gl;
    while (this.pending.length > 0) {
      const { query, tag } = this.pending[0]!;
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
      const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
      if (!disjoint) out.push({ tag, ms: (gl.getQueryParameter(query, gl.QUERY_RESULT) as number) / 1e6 });
      gl.deleteQuery(query);
      this.pending.shift();
    }
    return out;
  }
}
