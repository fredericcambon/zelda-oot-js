/** A 16-bit PCM WAV file holding interleaved `samples` at `hz`. */
export function encodeWav(samples: Int16Array, channels: number, hz: number): Uint8Array {
  const bytes = samples.length * 2;
  const out = new Uint8Array(44 + bytes);
  const dv = new DataView(out.buffer);
  out.set(new TextEncoder().encode('RIFF'), 0);
  dv.setUint32(4, 36 + bytes, true);
  out.set(new TextEncoder().encode('WAVEfmt '), 8);
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, hz, true);
  dv.setUint32(28, hz * channels * 2, true);
  dv.setUint16(32, channels * 2, true);
  dv.setUint16(34, 16, true);
  out.set(new TextEncoder().encode('data'), 36);
  dv.setUint32(40, bytes, true);
  for (let i = 0; i < samples.length; i++) dv.setInt16(44 + i * 2, samples[i]!, true);
  return out;
}
