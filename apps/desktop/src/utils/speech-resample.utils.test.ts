import { describe, expect, it } from "vitest";

import {
  createStreamingSpeechDownsampler,
  downsampleForSpeech,
} from "./speech-resample.utils";

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

describe("createStreamingSpeechDownsampler", () => {
  it.each([48_000, 44_100, 32_000, 22_050, 96_000])(
    "matches the whole-recording filter at %i Hz across irregular chunks",
    (rate) => {
      const input = tone(1000, rate, 0.11);
      const expected = resampled(input, rate);
      const stream = createStreamingSpeechDownsampler(rate);
      if (!stream) throw new Error(`No stream resampler for ${rate}`);
      const output: number[] = [];
      let offset = 0;
      let index = 0;
      const sizes = [1, 3, 100, 7, 1024, 2, 311];
      while (offset < input.length) {
        const end = Math.min(
          input.length,
          offset + sizes[index++ % sizes.length],
        );
        output.push(...stream.process(input.subarray(offset, end)));
        offset = end;
      }
      output.push(...stream.flush());
      expect(Float32Array.from(output)).toEqual(expected);
      expect(stream.flush()).toHaveLength(0);
    },
  );

  it("preserves short input and can reset without leaking a previous recording", () => {
    const stream = createStreamingSpeechDownsampler(48_000);
    if (!stream) throw new Error("No stream resampler");
    stream.process(new Float32Array(100).fill(-0.5));
    stream.reset();
    const input = new Float32Array(9).fill(0.25);
    const head = stream.process(input);
    const tail = stream.flush();
    expect(head).toHaveLength(0);
    expect(Float32Array.from([...head, ...tail])).toEqual(
      resampled(input, 48_000),
    );
  });

  it("removes out-of-band content instead of aliasing into the speech band", () => {
    const stream = createStreamingSpeechDownsampler(48_000);
    if (!stream) throw new Error("No stream resampler");
    const input = tone(12_000, 48_000, 0.2);
    const output = Float32Array.from([
      ...stream.process(input.subarray(0, 4000)),
      ...stream.process(input.subarray(4000)),
      ...stream.flush(),
    ]);
    expect(rms(output, 200)).toBeLessThan(0.005);
  });

  it("declines unsupported rates and ratios", () => {
    expect(createStreamingSpeechDownsampler(16_000)).toBeNull();
    expect(createStreamingSpeechDownsampler(44_101)).toBeNull();
    expect(createStreamingSpeechDownsampler(Infinity)).toBeNull();
    expect(createStreamingSpeechDownsampler(48_000_000)).toBeNull();
    expect(downsampleForSpeech(new Float32Array(1), 48_000_000)).toBeNull();
    expect(
      createStreamingSpeechDownsampler(Number.MAX_SAFE_INTEGER + 1),
    ).toBeNull();
  });
});
