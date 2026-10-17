import { describe, expect, it } from 'vitest';
import { averageSpectrum, fft, playbackSpeed, similarity } from './spectrum.ts';

const tone = (hz: number, rate: number, seconds: number) => Float64Array.from({ length: rate * seconds }, (_, i) => Math.sin((2 * Math.PI * hz * i) / rate));

describe('spectrum', () => {
  it('puts a tone at its own frequency', () => {
    const spectrum = averageSpectrum(tone(1000, 32000, 2));
    const peak = spectrum.indexOf(Math.max(...spectrum));
    expect((peak * 32000) / 8192).toBeCloseTo(1000, -1);
  });

  it('transforms an impulse into a flat spectrum', () => {
    const re = new Float64Array(8), im = new Float64Array(8);
    re[0] = 1;
    fft(re, im);
    expect(Array.from(re)).toEqual(new Array(8).fill(1));
  });

  it('tells a tone from the same tone a fifth higher', () => {
    const a = averageSpectrum(tone(500, 32000, 2)), same = averageSpectrum(tone(500, 32000, 2)), up = averageSpectrum(tone(600, 32000, 2));
    expect(similarity(a, same, 0, 1024)).toBeCloseTo(1, 5);
    expect(similarity(a, up, 0, 1024)).toBeLessThan(0.3);
    expect(similarity(a, up, 0, 1024, 1.2)).toBeGreaterThan(0.9);
  });
});

describe('playbackSpeed', () => {
  it('finds the factor by which a pulse train is sped up', () => {
    const pulses = (period: number) => Float64Array.from({ length: 6000 }, (_, i) => (Math.sin((2 * Math.PI * i) / period) > 0.6 ? 1 : 0.05));
    const found = playbackSpeed(pulses(100), pulses(100 / 1.2), 1000, 2500);
    expect(found.speed).toBeCloseTo(1.2, 1);
    expect(found.correlation).toBeGreaterThan(0.9);
  });
});
