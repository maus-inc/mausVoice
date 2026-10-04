import { describe, expect, it } from "vitest";

import { downsampleForSpeech } from "./speech-resample.utils";

const tone = (frequency: number, rate: number, seconds: number) => {
  const samples = new Float32Array(Math.round(rate * seconds));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = 0.5 * Math.sin((2 * Math.PI * frequency * index) / rate);
  }
  return samples;
};

const rms = (samples: Float32Array, trim: number) => {
  let sum = 0;
  let count = 0;
  for (let index = trim; index < samples.length - trim; index += 1) {
    sum += samples[index] * samples[index];
    count += 1;
  }
  return Math.sqrt(sum / count);
};

/**
 * `downsampleForSpeech` answers `null` when it declines to resample, which is a
 * real outcome the last test covers. Everywhere else a `null` is the function
 * failing at a rate it is supposed to handle, so it is reported as such rather
 * than asserted away with `!` -- which handed the next line `undefined` and
 * surfaced as a `TypeError` inside `rms` naming neither the rate nor the call.
 */
const resampled = (samples: Float32Array, rate: number): Float32Array => {
  const output = downsampleForSpeech(samples, rate);
  if (!output) {
    throw new Error(
      `Expected downsampleForSpeech to resample ${rate} Hz audio`,
    );
  }
  return output;
};

describe("downsampleForSpeech", () => {
  it.each([48_000, 44_100, 32_000, 22_050])(
    "produces 16 kHz output with the expected length from %i Hz",
    (rate) => {
      const output = resampled(new Float32Array(rate), rate);
      expect(output.length).toBe(16_000);
    },
  );

  it("keeps speech-band content at full level", () => {
    const output = resampled(tone(1_000, 48_000, 1), 48_000);
    expect(rms(output, 200)).toBeCloseTo(0.5 / Math.SQRT2, 2);
  });

  it("removes content above the 8 kHz output Nyquist instead of aliasing it", () => {
    for (const rate of [48_000, 44_100]) {
      const output = resampled(tone(12_000, rate, 1), rate);
      expect(rms(output, 200)).toBeLessThan(0.005);
    }
  });

  it("preserves a constant signal including the clip edges", () => {
    const output = resampled(new Float32Array(4_800).fill(0.25), 48_000);
    for (const sample of output) {
      expect(sample).toBeCloseTo(0.25, 5);
    }
  });

  it("returns null when no downsampling is needed or the ratio is impractical", () => {
    expect(downsampleForSpeech(new Float32Array(10), 16_000)).toBeNull();
    expect(downsampleForSpeech(new Float32Array(10), 8_000)).toBeNull();
    expect(downsampleForSpeech(new Float32Array(10), 44_101)).toBeNull();
  });
});
