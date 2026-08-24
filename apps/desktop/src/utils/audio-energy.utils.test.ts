import { describe, expect, it } from "vitest";
import {
  analyzeSilence,
  computePeak,
  computeRms,
  maxWindowedRms,
  SILENCE_PEAK_THRESHOLD,
  SILENCE_RMS_THRESHOLD,
} from "./audio-energy.utils";

const SAMPLE_RATE = 16000;

describe("computeRms", () => {
  it("returns 0 for empty input", () => {
    expect(computeRms([])).toBe(0);
    expect(computeRms(new Float32Array(0))).toBe(0);
  });

  it("computes the root mean square of a constant signal", () => {
    expect(computeRms([0.5, 0.5, -0.5, -0.5])).toBeCloseTo(0.5, 6);
  });

  it("is zero for digital silence", () => {
    expect(computeRms(new Float32Array(1024))).toBe(0);
  });
});

describe("computePeak", () => {
  it("returns the largest absolute sample", () => {
    expect(computePeak([0.1, -0.4, 0.2])).toBeCloseTo(0.4, 6);
  });
});

describe("maxWindowedRms", () => {
  it("finds the loudest 300ms window", () => {
    // Half a second of silence then half a second of tone.
    const samples = new Float32Array(SAMPLE_RATE);
    for (let i = SAMPLE_RATE / 2; i < SAMPLE_RATE; i++) {
      samples[i] = 0.2;
    }
    const max = maxWindowedRms(samples, SAMPLE_RATE);
    expect(max).toBeGreaterThan(0.1);
  });

  it("is near zero for silence", () => {
    const samples = new Float32Array(SAMPLE_RATE);
    expect(maxWindowedRms(samples, SAMPLE_RATE)).toBe(0);
  });
});

describe("analyzeSilence", () => {
  it("flags digital silence as silent", () => {
    const samples = new Float32Array(SAMPLE_RATE);
    const decision = analyzeSilence(samples, SAMPLE_RATE);
    expect(decision.silent).toBe(true);
  });

  it("flags low-amplitude room noise as silent", () => {
    // Well below both thresholds; a dictation with no speech must not be
    // sent to a cloud provider that could echo back dictionary words.
    const samples = new Float32Array(SAMPLE_RATE).map(
      () => (Math.random() - 0.5) * 0.001,
    );
    const decision = analyzeSilence(samples, SAMPLE_RATE);
    expect(decision.silent).toBe(true);
    expect(decision.rms).toBeLessThan(SILENCE_RMS_THRESHOLD);
    expect(decision.peak).toBeLessThan(SILENCE_PEAK_THRESHOLD);
  });

  it("does NOT flag normal speech-level audio as silent", () => {
    // A sustained tone at speech amplitude must survive the gate.
    const samples = new Float32Array(SAMPLE_RATE);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = 0.15 * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE);
    }
    const decision = analyzeSilence(samples, SAMPLE_RATE);
    expect(decision.silent).toBe(false);
    expect(decision.maxWindowRms).toBeGreaterThanOrEqual(SILENCE_RMS_THRESHOLD);
  });

  it("does NOT flag a single tiny transient as speech when the rest is silent", () => {
    // One low-level tick in an otherwise dead clip stays below the peak
    // threshold and has no sustained energy, so it remains gated.
    const samples = new Float32Array(SAMPLE_RATE);
    samples[100] = 0.01;
    const decision = analyzeSilence(samples, SAMPLE_RATE);
    expect(decision.silent).toBe(true);
  });
});
