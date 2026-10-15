// Accumulates the results of many display-list runs.
import type { DisplayListResult, UnknownCommand } from './dl.ts';

export class DlTotals {
  tasks = 0;
  commands = 0;
  triangles = 0;
  batches = 0;
  opcodes = new Map<number, number>();
  unknown: UnknownCommand[] = [];
  problems: string[] = [];

  add(r: DisplayListResult): void {
    this.tasks++;
    this.commands += r.commands;
    this.batches += r.batches.length;
    for (const b of r.batches) if (b.kind === 'triangles') this.triangles += b.positions.length / 12;
    for (const [op, n] of r.opcodes) this.opcodes.set(op, (this.opcodes.get(op) ?? 0) + n);
    this.unknown.push(...r.unknown);
    this.problems.push(...r.problems);
  }

  summary(): string {
    const ops = [...this.opcodes].sort((a, b) => a[0] - b[0]).map(([op, n]) => `${op.toString(16).padStart(2, '0')}:${n}`).join(' ');
    return [
      `${this.tasks} display lists, ${this.commands} commands, ${this.batches} batches, ${this.triangles} triangles`,
      `opcodes ${ops}`,
      `${this.unknown.length} unknown commands${this.unknown.slice(0, 5).map((u) => `\n  0x${u.addr.toString(16)}: ${u.w0.toString(16).padStart(8, '0')} ${u.w1.toString(16).padStart(8, '0')}`).join('')}`,
      `${this.problems.length} problems${this.problems.slice(0, 5).map((p) => `\n  ${p}`).join('')}`,
    ].join('\n');
  }
}
